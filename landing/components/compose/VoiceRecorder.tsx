"use client";

/**
 * VoiceRecorder — in-composer microphone capture for `juke.audio/app`.
 *
 * Web parity for the mobile `JukeVoiceRecorder` native module. Uses the
 * `MediaRecorder` API to capture a short voice note (hard-capped at the
 * backend's 60s limit), shows a live elapsed timer + a lightweight
 * `AnalyserNode`-driven level meter, and lets the user preview then either
 * discard (re-record) or attach the recording.
 *
 * Lifecycle hygiene:
 *   - Every `MediaStreamTrack` is stopped on stop / discard / unmount (releases
 *     the mic + its OS indicator).
 *   - The preview object URL is revoked whenever it is replaced or on unmount.
 *   - The `requestAnimationFrame` meter loop and the elapsed-time interval are
 *     both torn down.
 *
 * The parent (`CastComposer`) only renders this when recording is supported
 * (`pickRecorderMimeType(...) !== null`), so unsupported browsers never mount it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { formatDuration } from "@/lib/voice-notes";
import {
  MAX_RECORDING_MS,
  MIN_RECORDING_MS,
  pickRecorderMimeType,
  type RecordedVoiceNote,
} from "@/lib/api/voice-notes";

type Phase = "recording" | "recorded" | "error";

const METER_BAR_COUNT = 5;
const TIMER_INTERVAL_MS = 100;

export interface VoiceRecorderProps {
  /** Fired when the user attaches a finalized recording. */
  onComplete: (recording: RecordedVoiceNote) => void;
  /** Fired when the user aborts before attaching (cancel / permission error). */
  onCancel: () => void;
}

function permissionMessage(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access was blocked. Enable it in your browser settings and try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found. Connect one and try again.";
  }
  return "Couldn't start recording. Please try again.";
}

export function VoiceRecorder({ onComplete, onCancel }: VoiceRecorderProps) {
  const [phase, setPhase] = useState<Phase>("recording");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>(() =>
    new Array(METER_BAR_COUNT).fill(0),
  );

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const contentTypeRef = useRef<RecordedVoiceNote["contentType"]>("audio/mp4");
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const previewUrlRef = useRef<string | null>(null);
  const blobRef = useRef<Blob | null>(null);
  // Duration is measured from the timer, not MediaRecorder (which exposes none).
  const finalDurationRef = useRef<number>(0);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const stopMeter = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    analyserRef.current = null;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const setPreview = useCallback((url: string | null) => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = url;
    setPreviewUrl(url);
  }, []);

  const runMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buffer = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(buffer);
      // Split the spectrum into METER_BAR_COUNT bands, average each into 0..1.
      const bandSize = Math.floor(buffer.length / METER_BAR_COUNT) || 1;
      const next: number[] = [];
      for (let bar = 0; bar < METER_BAR_COUNT; bar += 1) {
        let sum = 0;
        for (let i = 0; i < bandSize; i += 1) {
          sum += buffer[bar * bandSize + i] ?? 0;
        }
        next.push(Math.min(1, sum / bandSize / 200));
      }
      setLevels(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const handleStop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      finalDurationRef.current = Date.now() - startTimeRef.current;
      recorderRef.current.stop();
    }
  }, []);

  const startRecording = useCallback(async () => {
    setErrorMessage(null);
    chunksRef.current = [];
    finalDurationRef.current = 0;
    setElapsedMs(0);
    setLevels(new Array(METER_BAR_COUNT).fill(0));

    const picked =
      typeof MediaRecorder !== "undefined"
        ? pickRecorderMimeType((t) => MediaRecorder.isTypeSupported(t))
        : null;
    if (!picked) {
      setPhase("error");
      setErrorMessage("Recording isn't supported in this browser.");
      return;
    }
    contentTypeRef.current = picked.uploadContentType;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setPhase("error");
      setErrorMessage(permissionMessage(err));
      return;
    }
    streamRef.current = stream;

    // Level meter (best-effort — a decode failure must not break recording).
    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new AudioCtx();
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;
      runMeter();
    } catch {
      // No meter — recording continues without the level indicator.
    }

    const recorder = new MediaRecorder(stream, { mimeType: picked.mimeType });
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      clearTimer();
      stopMeter();
      releaseStream();
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
      const url = URL.createObjectURL(blob);
      setPreview(url);
      blobRef.current = blob;
      setPhase("recorded");
    };

    recorder.start();
    setPhase("recording");
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_RECORDING_MS) handleStop();
    }, TIMER_INTERVAL_MS);
  }, [clearTimer, handleStop, releaseStream, runMeter, setPreview, stopMeter]);

  // Auto-start on mount (mic button already expressed intent to record).
  useEffect(() => {
    void startRecording();
    return () => {
      clearTimer();
      stopMeter();
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        // Detach onstop first: after unmount it would create an orphan object
        // URL (never revoked) and set state on a gone component.
        recorderRef.current.onstop = null;
        recorderRef.current.stop();
      }
      releaseStream();
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    };
    // Mount-only: startRecording is stable and re-running would restart capture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDiscard = useCallback(() => {
    setPreview(null);
    blobRef.current = null;
    void startRecording();
  }, [setPreview, startRecording]);

  const handleAttach = useCallback(() => {
    if (!blobRef.current) return;
    const durationMs = finalDurationRef.current || elapsedMs;
    if (durationMs < MIN_RECORDING_MS) {
      setErrorMessage("That recording was too short.");
      return;
    }
    onComplete({
      blob: blobRef.current,
      durationMs,
      contentType: contentTypeRef.current,
    });
  }, [elapsedMs, onComplete]);

  const atCap = elapsedMs >= MAX_RECORDING_MS;

  return (
    <div className="mt-3 rounded-xl border border-juke-border bg-juke-navy/40 p-3">
      {phase === "error" && (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-sm text-red-400">
            {errorMessage}
          </p>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Close
          </Button>
        </div>
      )}

      {phase === "recording" && (
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500"
              aria-hidden
            />
            <span
              aria-live="polite"
              aria-label={`Recording, ${Math.floor(elapsedMs / 1000)} seconds`}
              className="text-sm tabular-nums text-juke-text-on-dark"
            >
              {formatDuration(elapsedMs)}
              <span className="text-juke-text-on-dark-secondary">
                {" / "}
                {formatDuration(MAX_RECORDING_MS)}
              </span>
            </span>
            <div className="flex items-end gap-0.5" aria-hidden>
              {levels.map((level, i) => (
                <span
                  key={i}
                  className="w-1 rounded-full bg-juke-orange transition-[height] duration-75"
                  style={{ height: `${Math.max(4, level * 24)}px` }}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleStop}
              aria-label="Stop recording"
            >
              {atCap ? "Max reached" : "Stop"}
            </Button>
          </div>
        </div>
      )}

      {phase === "recorded" && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums text-juke-text-on-dark-secondary">
              {formatDuration(finalDurationRef.current || elapsedMs)}
            </span>
            {previewUrl && (
              // eslint-disable-next-line jsx-a11y/media-has-caption -- user's own transient recording; no caption source
              <audio
                src={previewUrl}
                controls
                className="h-9 min-w-0 flex-1"
              />
            )}
          </div>
          {errorMessage && (
            <p role="alert" className="text-sm text-red-400">
              {errorMessage}
            </p>
          )}
          <div className={cn("flex items-center justify-end gap-2")}>
            <Button variant="ghost" size="sm" onClick={handleDiscard}>
              Discard
            </Button>
            <Button variant="primary" size="sm" onClick={handleAttach}>
              Attach
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
