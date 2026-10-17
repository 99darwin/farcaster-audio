"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { safeImageUrl } from "@/lib/safe-url";
import {
  readPartnerTokenFromHash,
  stripPartnerToken,
} from "@/lib/embed-partner-token";
import {
  createJukeEmbedSdk,
  EmbedSignInPopupError,
  JukeEmbedAuthError,
  type JukeEmbedSdk,
} from "@/lib/juke-embed-sdk";
import type {
  JoinSpaceResponse,
  SpaceDetailResponse,
  SpaceParticipant,
} from "@/lib/spaces";

interface JukeSpaceEmbedProps {
  spaceId: string;
  initialData: SpaceDetailResponse;
  /**
   * `"off"` renders a passive second-screen view: shows title, host, and
   * participants but never connects audio or prompts to listen. Use when
   * the visitor already has audio playing elsewhere (the iOS app, another
   * tab) and would otherwise double-broadcast.
   */
  audioMode?: "on" | "off";
  /**
   * Partner-minted Juke JWT (from `POST /v1/developer/partner-tokens`)
   * passed via the deprecated `?token=` query. A `#token=` fragment, read
   * client-side, takes precedence. When present, the embed adopts the
   * session on mount and skips sign-in. The backend re-verifies on every
   * authed call so a forged token still fails at join time.
   */
  partnerToken?: string;
}

type Phase =
  | "idle"
  | "joining"
  | "connecting"
  | "listening"
  | "authenticating"
  | "participating"
  | "scheduled"
  | "ended"
  | "unsupported"
  | "error";

const REACTIONS: { key: string; glyph: string; label: string }[] = [
  { key: "clap", glyph: "👏", label: "Clap" },
  { key: "fire", glyph: "🔥", label: "Fire" },
  { key: "heart", glyph: "♡", label: "Heart" },
];

export function JukeSpaceEmbed({
  spaceId,
  initialData,
  audioMode = "on",
  partnerToken,
}: JukeSpaceEmbedProps) {
  const isAudioOff = audioMode === "off";
  const sdkRef = useRef<JukeEmbedSdk | null>(null);
  // Bumped on cancel/unmount so a late sign-in result is ignored.
  const signInAttemptRef = useRef(0);
  const [phase, setPhase] = useState<Phase>(() => {
    if (initialData.room.status === "scheduled") return "scheduled";
    if (initialData.room.status === "active") return "idle";
    return "ended";
  });
  const [error, setError] = useState<string | null>(null);
  const [roomMeta, setRoomMeta] = useState(initialData.room);
  const [participants, setParticipants] = useState(initialData.participants);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authenticatedFid, setAuthenticatedFid] = useState<number | null>(null);
  const [handRaised, setHandRaised] = useState(false);
  const [activeSpeakerFids, setActiveSpeakerFids] = useState<Set<number>>(
    new Set(),
  );
  const [isMicEnabled, setIsMicEnabled] = useState(false);
  // Outside a Mini App host, sign-in continues in a first-party juke.audio
  // popup. This frame can be embedded anywhere, so it never asks for the
  // recovery phrase itself.
  const [isWebSignInOpen, setIsWebSignInOpen] = useState(false);
  const popupAbortRef = useRef<AbortController | null>(null);

  if (!sdkRef.current) sdkRef.current = createJukeEmbedSdk();

  // Adopt a partner-minted JWT on mount when one was passed on the URL —
  // preferably as `#token=` (never sent to the server), else the deprecated
  // `?token=` (`lib/embed-partner-token.ts`). Runs once. Malformed/expired
  // tokens surface as a soft error so the visitor falls back to the regular
  // sign-in flow. Either form is stripped from the URL straight away so the
  // JWT doesn't linger in history, Referer headers or screen recordings.
  useEffect(() => {
    if (typeof window === "undefined" || !sdkRef.current) return;
    const token =
      readPartnerTokenFromHash(window.location.hash) ?? partnerToken;
    try {
      const stripped = stripPartnerToken(window.location.href);
      if (stripped !== window.location.href) {
        window.history.replaceState(window.history.state, "", stripped);
      }
    } catch {
      // No-op: a malformed location shouldn't break the embed.
    }
    if (!token) return;
    try {
      const session = sdkRef.current.adoptPartnerSession(token);
      setIsAuthenticated(true);
      setAuthenticatedFid(session.fid);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Partner sign-in is invalid — sign in with Farcaster to participate.",
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const syncFromJoin = useCallback(
    (join: JoinSpaceResponse) => {
      setRoomMeta(join.room);
      setParticipants(join.participants);
      const fid = sdkRef.current?.authenticatedFid ?? authenticatedFid;
      setHandRaised(
        fid !== null
          ? join.participants.some(
              (participant) =>
                participant.fid === fid && participant.hand_raised,
            )
          : false,
      );
    },
    [authenticatedFid],
  );

  const connectJoin = useCallback(
    async (join: JoinSpaceResponse, nextPhase: Phase) => {
      setPhase("connecting");
      await sdkRef.current?.connectAudio(join, {
        onActiveSpeakersChanged: (identities) => {
          setActiveSpeakerFids(
            new Set(
              identities
                .map(parseFidFromIdentity)
                .filter((fid): fid is number => fid !== null),
            ),
          );
        },
        onDisconnected: () => {
          setPhase((current) =>
            current === "listening" || current === "participating"
              ? "ended"
              : current,
          );
        },
      });
      setPhase(nextPhase);
    },
    [],
  );

  const handleListen = useCallback(async () => {
    unlockAudio();
    setError(null);
    setPhase("joining");

    try {
      const join = await sdkRef.current!.joinAnonymousListener(spaceId);
      syncFromJoin(join);
      await connectJoin(join, "listening");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not join";
      setError(message);
      setPhase(message.toLowerCase().includes("browser") ? "unsupported" : "error");
    }
  }, [connectJoin, spaceId, syncFromJoin]);

  const joinAsParticipant = useCallback(
    async (fid: number) => {
      setIsAuthenticated(true);
      setAuthenticatedFid(fid);
      setIsWebSignInOpen(false);
      const join = await sdkRef.current!.joinAuthenticated(spaceId);
      syncFromJoin(join);
      await connectJoin(join, "participating");
    },
    [connectJoin, spaceId, syncFromJoin],
  );

  const restoreConnectedPhase = useCallback(() => {
    setIsWebSignInOpen(false);
    setPhase(sdkRef.current?.isAuthenticated ? "participating" : "listening");
  }, []);

  const handleStartSignIn = useCallback(async () => {
    const attempt = ++signInAttemptRef.current;
    setError(null);
    setPhase("authenticating");

    try {
      // Protocol Auth via the Mini App host's wallet; null outside a host.
      const session = await sdkRef.current!.signInWithMiniApp();
      if (attempt !== signInAttemptRef.current) return;
      if (!session) {
        setIsWebSignInOpen(true);
        return;
      }
      await joinAsParticipant(session.fid);
    } catch (err) {
      if (attempt !== signInAttemptRef.current) return;
      const reason = err instanceof JukeEmbedAuthError ? err.reason : undefined;
      // Dismissing the wallet prompt is a choice, not an error.
      if (reason !== "user_cancelled") {
        setError(err instanceof Error ? err.message : "Could not sign in");
      }
      // Only a host wallet that isn't linked to the FID warrants the web
      // flow; network/timeout failures are retried from the same button.
      if (reason === "verify_failed") {
        setIsWebSignInOpen(true);
        return;
      }
      restoreConnectedPhase();
    }
  }, [joinAsParticipant, restoreConnectedPhase]);

  // Must run synchronously from the click so the popup isn't blocked.
  const handleOpenSignInPopup = useCallback(async () => {
    const attempt = signInAttemptRef.current;
    popupAbortRef.current?.abort();
    const controller = new AbortController();
    popupAbortRef.current = controller;
    setError(null);
    try {
      const session = await sdkRef.current!.signInWithPopup({
        signal: controller.signal,
      });
      if (attempt !== signInAttemptRef.current) return;
      await joinAsParticipant(session.fid);
    } catch (err) {
      if (attempt !== signInAttemptRef.current) return;
      if (err instanceof EmbedSignInPopupError) {
        // Closing the window keeps the offer open; a blocked popup says why.
        if (err.reason === "blocked") setError(err.message);
        return;
      }
      setError(err instanceof Error ? err.message : "Could not join");
      restoreConnectedPhase();
    } finally {
      if (popupAbortRef.current === controller) popupAbortRef.current = null;
    }
  }, [joinAsParticipant, restoreConnectedPhase]);

  const handleCancelSignIn = useCallback(() => {
    signInAttemptRef.current += 1;
    popupAbortRef.current?.abort();
    restoreConnectedPhase();
  }, [restoreConnectedPhase]);

  useEffect(() => {
    return () => {
      signInAttemptRef.current += 1;
      popupAbortRef.current?.abort();
      sdkRef.current?.leaveSpace().catch(() => {});
    };
  }, []);

  const handleLeave = useCallback(async () => {
    await sdkRef.current?.leaveSpace(spaceId);
    setIsMicEnabled(false);
    setHandRaised(false);
    setPhase("idle");
  }, [spaceId]);

  const handleReaction = useCallback(async (key: string) => {
    try {
      await sdkRef.current!.sendReaction(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in to react");
    }
  }, []);

  const handleRaiseHand = useCallback(async () => {
    try {
      const next = !handRaised;
      const response = await sdkRef.current!.raiseHand(spaceId, next);
      setHandRaised(response.hand_raised);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign in to raise your hand");
    }
  }, [handRaised, spaceId]);

  const handleMic = useCallback(async () => {
    try {
      const next = !isMicEnabled;
      await sdkRef.current!.enableMicrophone(next);
      setIsMicEnabled(next);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "A host must approve you before you can speak",
      );
    }
  }, [isMicEnabled]);

  const speakers = participants.filter((participant) =>
    ["host", "co_host", "speaker"].includes(participant.role),
  );
  const listenerCount = roomMeta.listener_count + roomMeta.speaker_count;
  const canListen = roomMeta.status === "active";
  const isBusy =
    phase === "joining" || phase === "connecting" || phase === "authenticating";
  const isConnected = phase === "listening" || phase === "participating";

  return (
    <section className="flex min-h-screen items-center justify-center bg-[#0f0f23] p-3 text-white sm:p-5">
      <div className="mx-auto flex w-full max-w-xl flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#151529] shadow-2xl shadow-black/30">
        <div className="flex flex-col gap-4 p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <StatusPill status={roomMeta.status} />
            <span className="text-xs text-white/45">
              {listenerCount} {listenerCount === 1 ? "person" : "people"} here
            </span>
            {isConnected && (
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-emerald-200">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                Listening
              </span>
            )}
            {isAudioOff && (
              <span className="ml-auto inline-flex items-center gap-1.5 text-xs font-medium text-white/55">
                <span className="h-1.5 w-1.5 rounded-full bg-white/40" />
                Audio off
              </span>
            )}
          </div>

          <h1 className="text-pretty text-2xl font-bold leading-tight text-white">
            {roomMeta.title}
          </h1>

          <HostLine room={roomMeta} />

          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            {speakers.length > 0 ? (
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                {speakers.slice(0, 8).map((participant) => (
                  <Speaker
                    key={participant.fid}
                    participant={participant}
                    isSpeaking={activeSpeakerFids.has(participant.fid)}
                  />
                ))}
              </div>
            ) : (
              <p className="py-4 text-center text-sm text-white/40">
                Speakers will appear here.
              </p>
            )}
          </div>

          {error && (
            <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-100">
              {error}
            </div>
          )}

          {phase === "scheduled" ? (
            <ScheduledCountdown scheduledAt={roomMeta.scheduled_at} />
          ) : isAudioOff ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-center text-sm text-white/60">
              Audio is off here — keep listening in the Juke app.
            </div>
          ) : (
            <ActionFooter
              phase={phase}
              canListen={canListen}
              isBusy={isBusy}
              isAuthenticated={isAuthenticated}
              handRaised={handRaised}
              isMicEnabled={isMicEnabled}
              isWebSignInOpen={isWebSignInOpen}
              onListen={handleListen}
              onSignIn={handleStartSignIn}
              onOpenSignInPopup={handleOpenSignInPopup}
              onCancelSignIn={handleCancelSignIn}
              onLeave={handleLeave}
              onReaction={handleReaction}
              onRaiseHand={handleRaiseHand}
              onMic={handleMic}
            />
          )}
        </div>

        <div className="flex items-center justify-between border-t border-white/5 px-5 py-3 text-xs text-white/35 sm:px-6">
          <span className="inline-flex items-center gap-2">
            <img
              src="/logomark.png"
              alt=""
              width={16}
              height={16}
              className="h-4 w-4"
            />
            Juke
          </span>
          <a
            href="https://juke.audio"
            target="_blank"
            rel="noopener noreferrer"
            className="transition hover:text-white/70"
          >
            juke.audio →
          </a>
        </div>
      </div>
    </section>
  );
}

function ActionFooter({
  phase,
  canListen,
  isBusy,
  isAuthenticated,
  handRaised,
  isMicEnabled,
  isWebSignInOpen,
  onListen,
  onSignIn,
  onOpenSignInPopup,
  onCancelSignIn,
  onLeave,
  onReaction,
  onRaiseHand,
  onMic,
}: {
  phase: Phase;
  canListen: boolean;
  isBusy: boolean;
  isAuthenticated: boolean;
  handRaised: boolean;
  isMicEnabled: boolean;
  isWebSignInOpen: boolean;
  onListen: () => void;
  onSignIn: () => void;
  onOpenSignInPopup: () => void;
  onCancelSignIn: () => void;
  onLeave: () => void;
  onReaction: (key: string) => void;
  onRaiseHand: () => void;
  onMic: () => void;
}) {
  // Web fallback (no Mini App host, or a host wallet that isn't linked):
  // sign in on juke.audio in a popup, never inside this frame.
  if (phase === "authenticating" && isWebSignInOpen) {
    return (
      <div className="space-y-3">
        <button
          type="button"
          onClick={onOpenSignInPopup}
          className="h-12 w-full rounded-full bg-[#855DCD] text-sm font-semibold text-white transition hover:bg-[#9670DB]"
        >
          Continue on juke.audio
        </button>
        <p className="text-center text-xs text-white/45">
          Opens a juke.audio window. Never enter your recovery phrase on any
          other site.
        </p>
        <button
          type="button"
          onClick={onCancelSignIn}
          className="h-10 w-full rounded-full text-sm font-medium text-white/60 transition hover:text-white/85"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (phase === "joining" || phase === "connecting" || phase === "authenticating") {
    const label =
      phase === "authenticating"
        ? "Waiting for sign in…"
        : phase === "joining"
          ? "Joining…"
          : "Connecting…";
    return (
      <button
        type="button"
        disabled
        className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-white/10 text-sm font-semibold text-white/60"
      >
        <span className="h-2 w-2 animate-pulse rounded-full bg-white/70" />
        {label}
      </button>
    );
  }

  if (phase === "ended") {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-center text-sm text-white/55">
        This space has ended.
      </div>
    );
  }

  if (phase === "idle" || phase === "error" || phase === "unsupported") {
    return (
      <button
        type="button"
        onClick={onListen}
        disabled={!canListen || isBusy}
        className="flex h-12 w-full items-center justify-center rounded-full bg-[#D85A30] text-sm font-semibold text-white transition hover:bg-[#E6693F] disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/35"
      >
        {phase === "unsupported"
          ? "Retry"
          : canListen
            ? "Tap to listen"
            : "Space ended"}
      </button>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-5 gap-2">
        {REACTIONS.map((reaction) => (
          <button
            key={reaction.key}
            type="button"
            onClick={() => onReaction(reaction.key)}
            disabled={!isAuthenticated}
            aria-label={reaction.label}
            className="flex h-11 items-center justify-center rounded-full bg-white/[0.06] text-lg transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {reaction.glyph}
          </button>
        ))}
        <button
          type="button"
          onClick={onRaiseHand}
          disabled={!isAuthenticated}
          aria-label={handRaised ? "Lower hand" : "Raise hand"}
          aria-pressed={handRaised}
          className={`flex h-11 items-center justify-center rounded-full text-lg transition disabled:cursor-not-allowed disabled:opacity-40 ${
            handRaised
              ? "bg-[#855DCD]/30 text-white"
              : "bg-white/[0.06] hover:bg-white/10"
          }`}
        >
          ✋
        </button>
        <button
          type="button"
          onClick={onMic}
          disabled={!isAuthenticated}
          aria-label={isMicEnabled ? "Mute" : "Unmute"}
          aria-pressed={isMicEnabled}
          className={`flex h-11 items-center justify-center rounded-full text-lg transition disabled:cursor-not-allowed disabled:opacity-40 ${
            isMicEnabled
              ? "bg-[#D85A30]/30 text-white"
              : "bg-white/[0.06] hover:bg-white/10"
          }`}
        >
          🎙
        </button>
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-2">
        {!isAuthenticated ? (
          <button
            type="button"
            onClick={onSignIn}
            className="h-11 rounded-full bg-[#855DCD] text-sm font-semibold text-white transition hover:bg-[#9670DB]"
          >
            Sign in to participate
          </button>
        ) : (
          <span className="flex h-11 items-center justify-center rounded-full bg-white/[0.04] text-sm font-medium text-white/65">
            Signed in
          </span>
        )}
        <button
          type="button"
          onClick={onLeave}
          className="h-11 rounded-full bg-white/[0.06] px-5 text-sm font-medium text-white/70 transition hover:bg-white/10"
        >
          Leave
        </button>
      </div>
    </div>
  );
}

function ScheduledCountdown({ scheduledAt }: { scheduledAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!scheduledAt) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-center text-sm text-white/60">
        Starts soon — check back in a minute.
      </div>
    );
  }

  const startsAtMs = new Date(scheduledAt).getTime();
  const remainingMs = Number.isFinite(startsAtMs) ? startsAtMs - now : 0;

  if (remainingMs <= 0) {
    return (
      <div className="rounded-2xl border border-emerald-300/30 bg-emerald-500/10 px-4 py-4 text-center text-sm text-emerald-100">
        Going live now — refresh in a moment to listen.
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-5 text-center">
      <p className="text-[11px] uppercase tracking-wider text-white/45">
        Starts in
      </p>
      <p
        className="mt-1 font-mono text-2xl font-semibold tabular-nums text-white"
        aria-live="polite"
      >
        {formatRemaining(remainingMs)}
      </p>
      <p className="mt-2 text-xs text-white/45">
        {new Date(scheduledAt).toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          timeZoneName: "short",
        })}
      </p>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function HostLine({ room }: { room: SpaceDetailResponse["room"] }) {
  const safePfp = safeImageUrl(room.host.pfp_url);
  return (
    <div className="flex items-center gap-2 text-sm text-white/55">
      {safePfp ? (
        <img
          src={safePfp}
          alt=""
          width={20}
          height={20}
          referrerPolicy="no-referrer"
          className="h-5 w-5 rounded-full object-cover"
        />
      ) : (
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-[10px] font-semibold text-white/70">
          {room.host.display_name.charAt(0).toUpperCase()}
        </div>
      )}
      <span>
        Hosted by{" "}
        <span className="font-medium text-white/85">
          @{room.host.username || room.host.display_name}
        </span>
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const live = status === "active";
  const scheduled = status === "scheduled";
  const label = live
    ? "Live"
    : scheduled
      ? "Scheduled"
      : status === "ended"
        ? "Ended"
        : status;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        live
          ? "bg-[#D85A30]/20 text-[#ffb199]"
          : scheduled
            ? "bg-[#855DCD]/20 text-[#c4afe8]"
            : "bg-white/10 text-white/50"
      }`}
    >
      {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#D85A30]" />}
      {label}
    </span>
  );
}

function Speaker({
  participant,
  isSpeaking,
}: {
  participant: SpaceParticipant;
  isSpeaking: boolean;
}) {
  const safePfp = safeImageUrl(participant.pfp_url);
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5">
      <div
        className={`relative h-14 w-14 rounded-full p-0.5 transition ${
          isSpeaking
            ? "ring-2 ring-[#D85A30] shadow-[0_0_20px_rgba(216,90,48,0.35)]"
            : "ring-1 ring-white/10"
        }`}
      >
        <div className="h-full w-full overflow-hidden rounded-full bg-white/10">
          {safePfp ? (
            <img
              src={safePfp}
              alt=""
              referrerPolicy="no-referrer"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-sm font-semibold text-white/75">
              {participant.display_name.charAt(0).toUpperCase()}
            </div>
          )}
        </div>
      </div>
      <span className="max-w-full truncate text-xs text-white/65">
        {participant.display_name}
      </span>
    </div>
  );
}

function unlockAudio() {
  const AudioCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtor) return;
  const context = new AudioCtor();
  const buffer = context.createBuffer(1, 1, 22050);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  if (context.state === "suspended") context.resume().catch(() => {});
}

function parseFidFromIdentity(identity: string): number | null {
  if (!/^\d+$/.test(identity)) return null;
  const fid = Number.parseInt(identity, 10);
  return Number.isFinite(fid) ? fid : null;
}
