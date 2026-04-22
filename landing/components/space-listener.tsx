"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import sdk from "@farcaster/miniapp-sdk";
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
} from "livekit-client";
import { getCachedMiniappAuth } from "@/lib/miniapp-auth";
import { jukeSpaceUrl } from "@/lib/deeplink";
import { safeImageUrl } from "@/lib/safe-url";
import {
  joinSpaceAsListener,
  type SpaceDetailResponse,
  type SpaceParticipant,
} from "@/lib/spaces";

interface SpaceListenerProps {
  spaceId: string;
  initialData: SpaceDetailResponse;
}

type Phase =
  | "idle" // waiting for user tap
  | "authenticating" // SIWF flow
  | "joining" // fetching LiveKit token
  | "connecting" // connecting to LiveKit
  | "listening" // connected, streaming audio
  | "ended" // room ended / disconnected
  | "error";

/**
 * Listener UI for a live space.
 *
 * Connection is deferred until the user taps "Listen" so the browser
 * treats the audio playback as a user-initiated gesture (required on iOS
 * webviews). The Warpcast silent-switch caveat is surfaced in the UI.
 */
export function SpaceListener({ spaceId, initialData }: SpaceListenerProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [roomMeta, setRoomMeta] = useState(initialData.room);
  const [participants, setParticipants] = useState<SpaceParticipant[]>(
    initialData.participants,
  );
  const [activeSpeakerFids, setActiveSpeakerFids] = useState<Set<number>>(
    new Set(),
  );

  const roomRef = useRef<Room | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Lookup table so we can map LiveKit identities ("fid-123") back to our
  // participant objects when active speakers change.
  const participantByFid = useRef<Map<number, SpaceParticipant>>(new Map());
  useEffect(() => {
    const map = new Map<number, SpaceParticipant>();
    for (const p of participants) map.set(p.fid, p);
    participantByFid.current = map;
  }, [participants]);

  // Cleanup on unmount: always disconnect the room.
  useEffect(() => {
    return () => {
      if (roomRef.current) {
        roomRef.current.disconnect().catch(() => {});
        roomRef.current = null;
      }
    };
  }, []);

  const unlockAudio = useCallback(() => {
    if (audioCtxRef.current) return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    const ctx = new AudioCtx();
    audioCtxRef.current = ctx;
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    if (ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }
  }, []);

  const handleListen = useCallback(async () => {
    // Capture the user gesture IMMEDIATELY — iOS requires the audio unlock
    // to happen synchronously in the same task as the tap.
    unlockAudio();

    setPhase("authenticating");
    setErrorMessage(null);

    const auth = await getCachedMiniappAuth();
    if (!auth.ok) {
      setPhase("error");
      setErrorMessage(
        auth.reason === "user_cancelled"
          ? "Sign-in required to listen"
          : auth.reason === "verify_failed"
            ? "Authentication failed"
            : auth.reason === "network"
              ? "Network error — please try again"
              : "Couldn't sign in",
      );
      return;
    }

    setPhase("joining");
    const join = await joinSpaceAsListener(spaceId, auth.token);
    if (!join) {
      setPhase("error");
      setErrorMessage("Couldn't join this space");
      return;
    }

    setRoomMeta(join.room);
    setParticipants(join.participants);

    setPhase("connecting");
    const room = new Room({
      adaptiveStream: true,
      dynacast: false, // listener-only, no uplink
    });
    roomRef.current = room;

    // Attach remote audio tracks to a hidden <audio> element so iOS will
    // play them through the existing audio session unlocked above.
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.setAttribute("playsinline", "true");
      // Keep audio elements mounted but invisible — autoplay is safe since
      // we already unlocked the session via user gesture.
      el.style.display = "none";
      document.body.appendChild(el);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => el.remove());
    });

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const fids = new Set<number>();
      for (const s of speakers) {
        const fid = parseFidFromIdentity(s.identity);
        if (fid !== null) fids.add(fid);
      }
      setActiveSpeakerFids(fids);
    });

    const refreshParticipantsFromRoom = () => {
      const byFid = new Map(participantByFid.current);
      for (const [, p] of room.remoteParticipants) {
        const fid = parseFidFromIdentity(p.identity);
        if (fid === null) continue;
        if (!byFid.has(fid)) {
          // Speaker who just joined but isn't in our initial list; backfill
          // with a minimal placeholder. We intentionally do NOT trust
          // `p.name` from LiveKit — it's populated by the SFU from the JWT
          // claim and could display an unverified string. The authoritative
          // display name arrives when the backend participant list refreshes.
          byFid.set(fid, {
            fid,
            role: "listener",
            is_muted: false,
            hand_raised: false,
            display_name: `fid:${fid}`,
            pfp_url: null,
          });
        }
      }
      setParticipants(Array.from(byFid.values()));
    };

    room.on(RoomEvent.ParticipantConnected, refreshParticipantsFromRoom);
    room.on(RoomEvent.ParticipantDisconnected, refreshParticipantsFromRoom);

    room.on(RoomEvent.Disconnected, () => {
      setPhase("ended");
      // Detach any lingering audio elements.
      document
        .querySelectorAll('audio[data-lk-local-participant="false"]')
        .forEach((el) => el.remove());
    });

    try {
      await room.connect(join.livekit_ws_url, join.livekit_token, {
        autoSubscribe: true,
      });
      // Clear the token from memory once the WebSocket connection is
      // established; LiveKit holds its own copy internally for reconnects.
      join.livekit_token = "";
      setPhase("listening");
    } catch {
      setPhase("error");
      setErrorMessage("Connection failed");
    }
  }, [spaceId, unlockAudio]);

  const handleLeave = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    if (room) {
      await room.disconnect().catch(() => {});
    }
    // Navigate back; Link fallback handled by user.
    window.history.back();
  }, []);

  const jukeDeeplink = jukeSpaceUrl(spaceId);
  const handleOpenInJuke = useCallback(() => {
    if (!jukeDeeplink) {
      console.warn("[space-listener] refusing to open invalid space id", spaceId);
      return;
    }
    sdk.actions.openUrl(jukeDeeplink);
  }, [jukeDeeplink, spaceId]);

  const speakers = participants.filter(
    (p) => p.role === "host" || p.role === "co_host" || p.role === "speaker",
  );

  return (
    <div className="relative flex min-h-screen flex-col px-4 pb-28 pt-6">
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

      {/* Live pill */}
      <div className="mb-3 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-white/50">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-red-500" />
        </span>
        Live
      </div>

      {/* Title */}
      <h1 className="mb-2 text-xl font-bold leading-tight text-white">
        {roomMeta.title}
      </h1>

      {/* Host chip */}
      <div className="mb-6 flex items-center gap-2 text-xs text-white/50">
        {safeImageUrl(roomMeta.host.pfp_url) ? (
          <img
            src={safeImageUrl(roomMeta.host.pfp_url) as string}
            alt=""
            width={20}
            height={20}
            referrerPolicy="no-referrer"
            className="h-5 w-5 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-white/10 text-[10px] font-bold">
            {roomMeta.host.display_name.charAt(0).toUpperCase()}
          </div>
        )}
        <span>
          Hosted by @{roomMeta.host.username} · {roomMeta.listener_count}{" "}
          {roomMeta.listener_count === 1 ? "listener" : "listeners"}
        </span>
      </div>

      {/* Speaker grid */}
      <section className="mb-8">
        <h2 className="mb-3 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-white/40">
          Speakers
        </h2>
        {speakers.length === 0 ? (
          <p className="text-sm text-white/30">No speakers yet.</p>
        ) : (
          <div className="grid grid-cols-4 gap-4">
            {speakers.map((p) => (
              <SpeakerCell
                key={p.fid}
                participant={p}
                isSpeaking={activeSpeakerFids.has(p.fid)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Phase-driven primary action area */}
      {phase === "idle" && (
        <div className="mt-auto mb-4 space-y-3">
          <p className="text-center text-[11px] leading-relaxed text-white/40">
            Audio may require your device&apos;s silent switch to be off,
            depending on Warpcast&apos;s settings.
          </p>
        </div>
      )}

      {phase === "error" && errorMessage && (
        <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-center text-sm text-red-300">
          {errorMessage}
        </div>
      )}

      {phase === "ended" && (
        <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center">
          <p className="mb-3 text-sm font-semibold text-white/80">
            Space ended
          </p>
          <Link
            href="/miniapp"
            className="inline-flex items-center justify-center rounded-full bg-white/10 px-5 py-2 text-xs font-medium text-white/70 transition-colors hover:bg-white/15"
          >
            Back to feed
          </Link>
        </div>
      )}

      {/* Bottom CTA bar */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-white/10 bg-[#0f0f23]/95 px-4 py-3 backdrop-blur-sm">
        {phase === "idle" || phase === "error" ? (
          <button
            onClick={handleListen}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-[#D85A30] py-3 text-sm font-bold text-white transition-colors hover:bg-[#c24e28]"
          >
            <svg
              viewBox="0 0 24 24"
              fill="currentColor"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M12 3a9 9 0 0 0-9 9v5.25A2.25 2.25 0 0 0 5.25 19.5H6.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H4.5V12a7.5 7.5 0 1 1 15 0v.75h-2.25a.75.75 0 0 0-.75.75v5.25c0 .414.336.75.75.75h1.5a2.25 2.25 0 0 0 2.25-2.25V12a9 9 0 0 0-9-9Z" />
            </svg>
            Listen
          </button>
        ) : phase === "authenticating" ||
          phase === "joining" ||
          phase === "connecting" ? (
          <button
            disabled
            className="flex w-full items-center justify-center gap-2 rounded-full bg-white/10 py-3 text-sm font-bold text-white/60"
          >
            <span className="h-2 w-2 animate-pulse rounded-full bg-white/60" />
            {phase === "authenticating"
              ? "Signing in…"
              : phase === "joining"
                ? "Joining…"
                : "Connecting…"}
          </button>
        ) : phase === "listening" ? (
          <div className="flex gap-2">
            <button
              onClick={handleOpenInJuke}
              className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[#D85A30] py-3 text-sm font-bold text-white transition-colors hover:bg-[#c24e28]"
            >
              Join to speak
            </button>
            <button
              onClick={handleLeave}
              className="flex items-center justify-center rounded-full bg-white/10 px-5 py-3 text-sm font-semibold text-white/70 transition-colors hover:bg-white/15"
            >
              Leave
            </button>
          </div>
        ) : phase === "ended" ? (
          <Link
            href="/miniapp"
            className="flex w-full items-center justify-center rounded-full bg-white/10 py-3 text-sm font-bold text-white/70 transition-colors hover:bg-white/15"
          >
            Back to feed
          </Link>
        ) : null}
      </div>
    </div>
  );
}

interface SpeakerCellProps {
  participant: SpaceParticipant;
  isSpeaking: boolean;
}

function SpeakerCell({ participant, isSpeaking }: SpeakerCellProps) {
  const initial = participant.display_name.charAt(0).toUpperCase();
  const safePfp = safeImageUrl(participant.pfp_url);
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={`relative h-14 w-14 overflow-hidden rounded-full border-2 transition-colors ${
          isSpeaking ? "border-[#D85A30]" : "border-white/10"
        }`}
      >
        {safePfp ? (
          <img
            src={safePfp}
            alt=""
            referrerPolicy="no-referrer"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-white/10 text-sm font-bold text-white/80">
            {initial}
          </div>
        )}
        {participant.role === "host" && (
          <span className="absolute bottom-0 right-0 rounded-full bg-[#D85A30] px-1 font-mono text-[8px] font-bold uppercase text-white">
            Host
          </span>
        )}
      </div>
      <span className="line-clamp-1 font-mono text-[10px] text-white/50">
        {participant.display_name}
      </span>
    </div>
  );
}

function parseFidFromIdentity(identity: string): number | null {
  // Backend encodes LiveKit identities as the bare stringified FID
  // (see `livekit_service.py:65` — `token.with_identity(str(fid))`).
  if (!/^\d+$/.test(identity)) return null;
  const fid = parseInt(identity, 10);
  return Number.isFinite(fid) ? fid : null;
}
