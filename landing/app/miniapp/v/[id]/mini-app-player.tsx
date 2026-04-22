"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import sdk from "@farcaster/miniapp-sdk";
import { Waveform, BAR_COUNT } from "@/components/waveform";
import { getCachedMiniappAuth } from "@/lib/miniapp-auth";
import { jukeVoiceNoteUrl } from "@/lib/deeplink";
import { safeImageUrl } from "@/lib/safe-url";
import {
  formatDuration,
  formatTimestamp,
  type VoiceNoteDetail,
} from "@/lib/voice-notes";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://your-api-host.example.com";
const APP_STORE_URL =
  "https://testflight.apple.com/join/YOUR_TESTFLIGHT_CODE";
const PLAY_TRACK_DELAY_MS = 3000;
const SPEED_OPTIONS = [1, 1.25, 1.5, 2] as const;

interface MiniAppPlayerProps {
  data: VoiceNoteDetail;
}

export function MiniAppPlayer({ data }: MiniAppPlayerProps) {
  const { voice_note, author, reaction_counts, play_count } = data;

  const audioRef = useRef<HTMLAudioElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  const playTrackedRef = useRef(false);
  const playStartRef = useRef<number>(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTimeMs, setCurrentTimeMs] = useState(0);
  const [isLoaded, setIsLoaded] = useState(false);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showEndOverlay, setShowEndOverlay] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [viewerFid, setViewerFid] = useState<number | null>(null);
  const [localReactions, setLocalReactions] = useState<
    Record<string, number>
  >(reaction_counts);
  const [myReactions, setMyReactions] = useState<Set<string>>(new Set());
  const [contextClientFid, setContextClientFid] = useState<number | null>(
    null,
  );
  const [isAdded, setIsAdded] = useState(false);
  const [addPromptDismissed, setAddPromptDismissed] = useState(false);

  const peaks =
    voice_note.waveform_peaks ??
    Array.from({ length: BAR_COUNT }, () => Math.random() * 0.6 + 0.1);
  const progress =
    voice_note.duration_ms > 0 ? currentTimeMs / voice_note.duration_ms : 0;

  // SDK init
  useEffect(() => {
    async function init() {
      const context = await sdk.context;
      if (context?.user?.fid) {
        setViewerFid(context.user.fid);
      }
      if (context?.client?.clientFid) {
        setContextClientFid(context.client.clientFid);
      }
      if (context?.client?.added) {
        setIsAdded(true);
      }
      sdk.actions.ready();
    }
    init();
  }, []);

  // Animation frame time updater
  const updateTime = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTimeMs(audio.currentTime * 1000);
    if (!audio.paused) {
      rafRef.current = requestAnimationFrame(updateTime);
    }
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // Play tracking after 3s
  useEffect(() => {
    if (!isPlaying || playTrackedRef.current) return;

    const elapsed = Date.now() - playStartRef.current;
    const remaining = PLAY_TRACK_DELAY_MS - elapsed;
    if (remaining <= 0) {
      trackPlay();
      return;
    }

    const timer = setTimeout(trackPlay, remaining);
    return () => clearTimeout(timer);

    function trackPlay() {
      if (playTrackedRef.current) return;
      playTrackedRef.current = true;
      fetch(`${API_BASE_URL}/v1/voice-notes/${voice_note.id}/plays`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listened_ms: PLAY_TRACK_DELAY_MS,
          completed: false,
          source: "miniapp",
        }),
      }).catch(() => {});
    }
  }, [isPlaying, voice_note.id]);

  // Unlock audio session on first user gesture (needed in iframes/webviews)
  const unlockAudio = useCallback(() => {
    if (audioCtxRef.current) return;
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    audioCtxRef.current = ctx;
    // Play a silent buffer to activate the audio session
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    // Resume if suspended
    if (ctx.state === "suspended") {
      ctx.resume();
    }
  }, []);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    // Ensure audio context is unlocked on first tap
    unlockAudio();

    if (audio.paused) {
      setShowEndOverlay(false);
      await audio.play();
      setIsPlaying(true);
      if (!playTrackedRef.current) {
        playStartRef.current = Date.now();
      }
      rafRef.current = requestAnimationFrame(updateTime);
    } else {
      audio.pause();
      setIsPlaying(false);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    }
  }, [updateTime, unlockAudio]);

  const handleSeek = useCallback(
    (fraction: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = (fraction * voice_note.duration_ms) / 1000;
      setCurrentTimeMs(fraction * voice_note.duration_ms);
    },
    [voice_note.duration_ms],
  );

  const handleEnded = useCallback(() => {
    setIsPlaying(false);
    setCurrentTimeMs(0);
    setShowEndOverlay(true);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
  }, []);

  const cycleSpeed = useCallback(() => {
    const next = (speedIndex + 1) % SPEED_OPTIONS.length;
    setSpeedIndex(next);
    const audio = audioRef.current;
    if (audio) audio.playbackRate = SPEED_OPTIONS[next];
  }, [speedIndex]);

  // Auth via SIWF (shared helper; see lib/miniapp-auth.ts).
  // Uses the cached variant so consecutive reactions don't re-prompt.
  const authenticate = useCallback(async () => {
    const result = await getCachedMiniappAuth();
    if (!result.ok) {
      if (result.reason === "verify_failed") {
        // Don't auto-retry — surface a user-visible error so they know
        // something is wrong on the server side.
        setAuthError("Authentication failed");
      } else if (result.reason === "network") {
        setAuthError("Network error");
      }
      return null;
    }
    setAuthError(null);
    setToken(result.token);
    if (result.fid) setViewerFid(result.fid);
    return result.token;
  }, []);

  const handleReaction = useCallback(
    async (type: "like" | "recast") => {
      let authToken = token;
      if (!authToken) {
        authToken = await authenticate();
        if (!authToken) return;
      }

      const alreadyReacted = myReactions.has(type);

      // Optimistic update
      setLocalReactions((prev) => ({
        ...prev,
        [type]: (prev[type] || 0) + (alreadyReacted ? -1 : 1),
      }));
      setMyReactions((prev) => {
        const next = new Set(prev);
        if (alreadyReacted) next.delete(type);
        else next.add(type);
        return next;
      });

      const url = alreadyReacted
        ? `${API_BASE_URL}/v1/voice-notes/${voice_note.id}/reactions/${type}`
        : `${API_BASE_URL}/v1/voice-notes/${voice_note.id}/reactions`;

      fetch(url, {
        method: alreadyReacted ? "DELETE" : "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        ...(!alreadyReacted && {
          body: JSON.stringify({ reaction_type: type }),
        }),
      }).catch(() => {
        // Revert on failure
        setLocalReactions((prev) => ({
          ...prev,
          [type]: (prev[type] || 0) + (alreadyReacted ? 1 : -1),
        }));
        setMyReactions((prev) => {
          const next = new Set(prev);
          if (alreadyReacted) next.add(type);
          else next.delete(type);
          return next;
        });
      });
    },
    [token, myReactions, voice_note.id, authenticate],
  );

  const handleReply = useCallback(() => {
    if (voice_note.cast_hash) {
      sdk.actions.composeCast({
        parent: { type: "cast", hash: voice_note.cast_hash },
      });
    }
  }, [voice_note.cast_hash]);

  const handleShare = useCallback(() => {
    sdk.actions.composeCast({
      text: "",
      embeds: [`https://juke.audio/v/${voice_note.id}`],
    });
  }, [voice_note.id]);

  const handleViewProfile = useCallback(() => {
    sdk.actions.viewProfile({ fid: author.fid });
  }, [author.fid]);

  const handleAddMiniApp = useCallback(async () => {
    try {
      const result = await sdk.actions.addMiniApp();
      setIsAdded(true);
      // If notifications were granted with the add, the webhook will handle persistence
    } catch {
      // User rejected or invalid manifest — no action needed
    }
  }, []);

  const openInJukeUrl = (() => {
    const params = new URLSearchParams({
      source: "miniapp",
      ...(contextClientFid && { host: String(contextClientFid) }),
      vn: voice_note.id,
    });
    return `${APP_STORE_URL}?${params}`;
  })();

  function formatTime(ms: number): string {
    const secs = Math.floor(ms / 1000);
    const mins = Math.floor(secs / 60);
    const remainSecs = secs % 60;
    return `${mins}:${remainSecs.toString().padStart(2, "0")}`;
  }

  return (
    <div className="relative flex min-h-screen flex-col px-4 pb-24 pt-6">
      <audio
        ref={audioRef}
        src={voice_note.audio_url}
        preload="metadata"
        onEnded={handleEnded}
        onLoadedMetadata={() => setIsLoaded(true)}
      />

      {/* Back to feed */}
      <Link
        href="/miniapp"
        className="mb-4 flex items-center gap-1 self-start text-xs text-white/40 transition-colors hover:text-white/60"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
          <path
            fillRule="evenodd"
            d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
            clipRule="evenodd"
          />
        </svg>
        Feed
      </Link>

      {/* Author chip */}
      <button
        onClick={handleViewProfile}
        className="mb-6 flex items-center gap-2.5 self-start"
      >
        {safeImageUrl(author.pfp_url) ? (
          <img
            src={safeImageUrl(author.pfp_url) as string}
            alt=""
            width={36}
            height={36}
            referrerPolicy="no-referrer"
            className="h-9 w-9 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-sm font-bold">
            {author.display_name.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="min-w-0 text-left">
          <p className="truncate text-sm font-semibold">
            @{author.username}
            <span className="ml-1.5 font-normal text-white/40">on Juke</span>
          </p>
          <p className="text-xs text-white/40">
            {formatTimestamp(voice_note.created_at)}
          </p>
        </div>
      </button>

      {/* Caption */}
      {voice_note.caption && (
        <p className="mb-4 text-sm leading-relaxed text-white/70">
          {voice_note.caption}
        </p>
      )}

      {/* Player controls */}
      <div className="mb-2 flex items-center gap-3">
        <button
          onClick={togglePlay}
          disabled={!isLoaded}
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#D85A30] text-white transition-colors hover:bg-[#c24e28] disabled:opacity-40"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-5 w-5"
            >
              <path
                fillRule="evenodd"
                d="M6.75 5.25a.75.75 0 0 1 .75-.75H9a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 1-.75-.75V5.25Zm7.5 0a.75.75 0 0 1 .75-.75H16.5a.75.75 0 0 1 .75.75v13.5a.75.75 0 0 1-.75.75H15a.75.75 0 0 1-.75-.75V5.25Z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="ml-0.5 h-5 w-5"
            >
              <path
                fillRule="evenodd"
                d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.28 19.99c-1.25.687-2.779-.217-2.779-1.643V5.653Z"
                clipRule="evenodd"
              />
            </svg>
          )}
        </button>

        <div className="flex-1">
          <Waveform
            peaks={peaks}
            progress={progress}
            onSeek={handleSeek}
            inactiveColor="#1e1e3a"
          />
        </div>

        {/* Speed control */}
        <button
          onClick={cycleSpeed}
          className="shrink-0 rounded-md bg-white/10 px-2 py-1 text-xs font-semibold tabular-nums text-white/70 transition-colors hover:bg-white/20"
        >
          {SPEED_OPTIONS[speedIndex]}x
        </button>
      </div>

      {/* Time display */}
      <div className="mb-5 flex items-center justify-between text-xs tabular-nums text-white/40">
        <span>{formatTime(currentTimeMs)}</span>
        <span>{formatDuration(voice_note.duration_ms)}</span>
      </div>

      {/* Reaction + stats row */}
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => handleReaction("like")}
          className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            myReactions.has("like")
              ? "bg-[#D85A30]/20 text-[#D85A30]"
              : "bg-white/10 text-white/60 hover:bg-white/15"
          }`}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path d="M9.653 16.915l-.005-.003-.019-.01a20.759 20.759 0 01-1.162-.682 22.045 22.045 0 01-2.582-1.9C4.045 12.733 2 10.352 2 7.5a4.5 4.5 0 018-2.828A4.5 4.5 0 0118 7.5c0 2.852-2.044 5.233-3.885 6.82a22.049 22.049 0 01-3.744 2.582l-.019.01-.005.003h-.002a.723.723 0 01-.692 0h-.002z" />
          </svg>
          {(localReactions["like"] || 0) > 0 && (
            <span>{localReactions["like"]}</span>
          )}
        </button>
        <button
          onClick={() => handleReaction("recast")}
          className={`flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
            myReactions.has("recast")
              ? "bg-green-500/20 text-green-400"
              : "bg-white/10 text-white/60 hover:bg-white/15"
          }`}
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
            <path
              fillRule="evenodd"
              d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H4.28a.75.75 0 00-.75.75v3.955a.75.75 0 001.5 0v-2.134l.235.234A7 7 0 0016.67 11.22a.75.75 0 10-1.358-.632zM4.688 8.576a5.5 5.5 0 019.201-2.466l.312.311h-2.433a.75.75 0 000 1.5h3.952a.75.75 0 00.75-.75V3.216a.75.75 0 00-1.5 0v2.134l-.235-.234A7 7 0 003.33 8.78a.75.75 0 001.358.632z"
              clipRule="evenodd"
            />
          </svg>
          {(localReactions["recast"] || 0) > 0 && (
            <span>{localReactions["recast"]}</span>
          )}
        </button>

        {voice_note.cast_hash && (
          <button
            onClick={handleReply}
            className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/15"
          >
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className="h-3.5 w-3.5"
            >
              <path
                fillRule="evenodd"
                d="M3.43 2.524A41.29 41.29 0 0110 2c2.236 0 4.43.18 6.57.524 1.437.231 2.43 1.49 2.43 2.902v5.148c0 1.413-.993 2.67-2.43 2.902a41.202 41.202 0 01-5.183.501l-2.7 2.7A.75.75 0 017.5 16.06v-2.39c-.61-.052-1.215-.118-1.813-.197C4.236 13.242 3 11.987 3 10.574V5.426c0-1.413.993-2.67 2.43-2.902z"
                clipRule="evenodd"
              />
            </svg>
            Reply
          </button>
        )}

        <button
          onClick={handleShare}
          className="flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/15"
        >
          <svg
            viewBox="0 0 20 20"
            fill="currentColor"
            className="h-3.5 w-3.5"
          >
            <path d="M13 4.5a2.5 2.5 0 115 0 2.5 2.5 0 01-5 0zM13 15.5a2.5 2.5 0 115 0 2.5 2.5 0 01-5 0zM2 10a2.5 2.5 0 115 0 2.5 2.5 0 01-5 0z" />
            <path d="M7 9l5.5-3M7 11l5.5 3" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
          Share
        </button>

        {authError && (
          <span className="text-xs text-red-400">{authError}</span>
        )}

        {play_count > 0 && (
          <span className="ml-auto text-xs text-white/30">
            {play_count.toLocaleString()} {play_count === 1 ? "play" : "plays"}
          </span>
        )}
      </div>

      {/* Transcript */}
      {voice_note.transcript && (
        <div className="mb-4">
          <button
            onClick={() => setShowTranscript(!showTranscript)}
            className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-white/40 transition-colors hover:text-white/60"
          >
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`h-3 w-3 transition-transform ${showTranscript ? "rotate-90" : ""}`}
            >
              <path
                fillRule="evenodd"
                d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                clipRule="evenodd"
              />
            </svg>
            Transcript
          </button>
          {showTranscript && (
            <p className="text-sm leading-relaxed text-white/60">
              {voice_note.transcript}
            </p>
          )}
        </div>
      )}

      {/* Post-playback overlay */}
      {showEndOverlay && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0f0f23]/90 px-6">
          <img
            src="/logomark.png"
            alt=""
            width={48}
            height={48}
            className="mb-3 h-12 w-12 brightness-0 invert"
          />
          <p className="mb-1 text-sm font-semibold text-white/80">
            Recorded with Juke
          </p>
          <p className="mb-6 text-xs text-white/40">
            Voice notes for Farcaster
          </p>
          {!isAdded ? (
            <button
              onClick={handleAddMiniApp}
              className="inline-flex items-center justify-center gap-2 rounded-full bg-[#6a3cff] px-8 py-3 text-sm font-bold text-white transition-colors hover:bg-[#5a30e0]"
            >
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
              </svg>
              Add Juke
            </button>
          ) : (
            <button
              onClick={() => sdk.actions.openUrl(openInJukeUrl)}
              className="inline-flex items-center justify-center rounded-full bg-[#D85A30] px-8 py-3 text-sm font-bold text-white transition-colors hover:bg-[#c24e28]"
            >
              Get the App
            </button>
          )}
          <button
            onClick={() => {
              setShowEndOverlay(false);
              togglePlay();
            }}
            className="mt-3 text-xs text-white/40 transition-colors hover:text-white/60"
          >
            Replay
          </button>
        </div>
      )}

      {/* Add miniapp prompt — shows after first play if not added */}
      {!isAdded && !addPromptDismissed && playTrackedRef.current && !showEndOverlay && (
        <div className="mb-4 flex items-center gap-3 rounded-xl bg-[#6a3cff]/10 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-white/80">
              Add Juke to your apps
            </p>
            <p className="text-xs text-white/40">
              Get notified when people you follow post voice notes
            </p>
          </div>
          <button
            onClick={handleAddMiniApp}
            className="shrink-0 rounded-full bg-[#6a3cff] px-4 py-1.5 text-xs font-bold text-white transition-colors hover:bg-[#5a30e0]"
          >
            Add
          </button>
          <button
            onClick={() => setAddPromptDismissed(true)}
            className="shrink-0 text-white/30 hover:text-white/50"
            aria-label="Dismiss"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
      )}

      {/* Bottom CTA bar */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-white/10 bg-[#0f0f23]/95 px-4 py-3 backdrop-blur-sm">
        <button
          onClick={() => {
            const deeplink = jukeVoiceNoteUrl(voice_note.id);
            if (!deeplink) {
              console.warn(
                "[mini-app-player] refusing to open invalid voice note id",
                voice_note.id,
              );
              return;
            }
            sdk.actions.openUrl(deeplink);
          }}
          disabled={!jukeVoiceNoteUrl(voice_note.id)}
          className="flex w-full items-center justify-center gap-2 rounded-full bg-[#D85A30] py-3 text-sm font-bold text-white transition-colors hover:bg-[#c24e28] disabled:opacity-40"
        >
          Open in Juke
        </button>
      </div>
    </div>
  );
}
