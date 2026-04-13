import { useState, useCallback, useEffect, useRef } from "react";
import { requireNativeModule, EventEmitter } from "expo-modules-core";

type RecorderState = "idle" | "recording" | "stopped" | "trimming";

const MAX_DURATION_MS = 60000;
const TIMER_INTERVAL_MS = 100;

interface RecordingResult {
  filePath: string;
  durationMs: number;
  peaks: number[];
}

function getNativeModule() {
  return requireNativeModule("JukeVoiceRecorder");
}

export function useVoiceNoteRecorder() {
  const [state, setState] = useState<RecorderState>("idle");
  const [result, setResult] = useState<RecordingResult | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [livePeaks, setLivePeaks] = useState<number[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const stoppingRef = useRef(false);
  const moduleRef = useRef<ReturnType<typeof getNativeModule> | null>(null);

  // Lazily initialize native module + event listener
  useEffect(() => {
    try {
      const mod = getNativeModule();
      moduleRef.current = mod;
      const emitter = new EventEmitter(mod);
      const sub = emitter.addListener(
        // @ts-expect-error -- EventEmitter typing doesn't know about native module events
        "onPeakLevel",
        (event: { level: number }) => {
          setLivePeaks((prev) => [...prev.slice(-199), event.level]);
        },
      );
      return () => sub.remove();
    } catch {
      // Native module not available (dev build without native module linked)
      console.warn(
        "[VoiceRecorder] JukeVoiceRecorder native module not available",
      );
    }
  }, []);

  const getModule = useCallback(() => {
    if (!moduleRef.current) {
      throw new Error(
        "JukeVoiceRecorder native module is not available. Rebuild the app with the native module.",
      );
    }
    return moduleRef.current;
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    clearTimer();
    try {
      const res = await getModule().stopRecording();
      setResult(res as RecordingResult);
      setState("stopped");
    } finally {
      stoppingRef.current = false;
    }
  }, [clearTimer, getModule]);

  const startRecording = useCallback(async () => {
    setLivePeaks([]);
    setElapsedMs(0);
    setResult(null);
    await getModule().startRecording();
    setState("recording");
    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      setElapsedMs(elapsed);
      if (elapsed >= MAX_DURATION_MS) {
        stopRecording();
      }
    }, TIMER_INTERVAL_MS);
  }, [stopRecording, getModule]);

  const cancelRecording = useCallback(async () => {
    clearTimer();
    await getModule().cancelRecording();
    setState("idle");
    setResult(null);
    setElapsedMs(0);
    setLivePeaks([]);
  }, [clearTimer, getModule]);

  const trimRecording = useCallback(
    async (startMs: number, endMs: number) => {
      if (!result) return;
      setState("trimming");
      const trimmed = await getModule().trimRecording(
        result.filePath,
        startMs,
        endMs,
      );
      setResult(trimmed as RecordingResult);
      setState("stopped");
    },
    [result, getModule],
  );

  const reset = useCallback(() => {
    clearTimer();
    setState("idle");
    setResult(null);
    setElapsedMs(0);
    setLivePeaks([]);
  }, [clearTimer]);

  const isAvailable = moduleRef.current !== null;

  return {
    state,
    result,
    elapsedMs,
    livePeaks,
    isAvailable,
    startRecording,
    stopRecording,
    cancelRecording,
    trimRecording,
    reset,
  };
}
