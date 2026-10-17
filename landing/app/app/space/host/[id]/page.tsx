"use client";

/**
 * Host console (Stream E).
 *
 * The primary landing surface after `create` takes a host live: it reflects the
 * active LiveKit session (speaker grid + listeners), the host's own mic
 * controls, live reactions, and the `<HostPanel/>` moderation sheet.
 *
 * Robust to a cold arrival (page reload / deep-link / notification handoff):
 * when the store has no live session for this id, we hydrate the room shell via
 * `getSpaceDetail` and offer a gesture-driven "Rejoin as host" that re-runs the
 * join → connect flow (which mints a fresh token and re-enables the host mic).
 *
 * Only the room's host may view this console — a non-host is redirected to the
 * listener view at `/app/space/[id]`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSpace } from "@/app/app/space/useSpace";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  getSpaceDetail,
  type SpaceDetailResponse,
  type SpaceParticipant,
} from "@/lib/spaces";
import {
  useSpaceStore,
  type SessionParticipant,
  type SpaceRole,
  type SpaceRoom,
} from "@/lib/space/spaceStore";
import { nativeStart } from "@/lib/native/nativeSpaceApi";
import { ensureRoomChatTarget } from "@/lib/space/chatApi";
import { AppKeyNotApprovedError } from "@/lib/native/appKeyApproval";
import { useAppKey } from "@/components/native/useAppKey";
import { ApproveAppKeyPrompt } from "@/components/native/ApproveAppKeyPrompt";
import { unlockAudioContext } from "@/lib/space/livekit";
import { safeImageUrl } from "@/lib/safe-url";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Sheet } from "@/components/ui/sheet";
import { SpeakerGrid } from "@/app/app/space/_components/SpeakerGrid";
import { ListenerList } from "@/app/app/space/_components/ListenerList";
import { Controls } from "@/app/app/space/_components/Controls";
import { ReactionsLayer } from "@/app/app/space/_components/ReactionsLayer";
import { HostPanel, canModerate } from "@/app/app/space/_components/HostPanel";
import { AudioSourcesPanel } from "@/app/app/space/_components/AudioSourcesPanel";
import { useNativeHeartbeat } from "@/app/app/space/useNativeHeartbeat";
import { SpaceChat } from "@/app/app/space/_components/SpaceChat";

type Phase = "loading" | "preview" | "rejoining" | "live" | "ended" | "error";

const SPEAKER_ROLES = new Set<SpaceRole>(["host", "co_host", "speaker"]);

function toSession(p: SpaceParticipant): SessionParticipant {
  return {
    fid: p.fid,
    role: p.role as SpaceRole,
    is_muted: p.is_muted,
    is_speaking: false,
    hand_raised: p.hand_raised,
    display_name: p.display_name,
    pfp_url: p.pfp_url,
  };
}

export default function HostConsolePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { user, status } = useAuth();

  const {
    room,
    participants,
    myRole,
    isConnected,
    isMuted,
    micPermissionDenied,
    reactions,
    joinRoom,
    connect,
    leaveRoom,
    toggleMute,
    retryMic,
    sendReaction,
    refreshNativeParticipants,
    setOnRoomEnded,
  } = useSpace();

  const appKey = useAppKey(user?.fid);

  const [detail, setDetail] = useState<SpaceDetailResponse | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [showApproval, setShowApproval] = useState(false);

  const isThisSessionLive = room?.id === id && isConnected;
  const isNative = !!(detail?.room as { is_farcaster_native?: boolean } | null)
    ?.is_farcaster_native;
  const roomIsLive =
    detail?.room.status === "active" || detail?.room.status === "live";

  // Resolve the room shell (header + host verification + ended detection).
  useEffect(() => {
    if (status === "loading") return;
    // The host console is for the authenticated host only. Anonymous users go
    // to the listener view — moderation is backend-enforced regardless, this
    // just avoids exposing the host shell.
    if (status === "anonymous") {
      router.replace(`/app/space/${id}`);
      return;
    }
    let active = true;
    (async () => {
      const data = await getSpaceDetail(id);
      if (!active) return;
      setDetail(data);

      // Not the host → this is the listener's console; send them to the
      // participant view instead of exposing moderation controls.
      if (data && user && data.room.host_fid !== user.fid) {
        router.replace(`/app/space/${id}`);
        return;
      }

      setPhase((prev) => {
        if (prev !== "loading") return prev;
        if (isThisSessionLive) return "live";
        if (data && (data.room.status === "ended" || data.room.ended_at)) {
          return "ended";
        }
        return "preview";
      });
    })();
    return () => {
      active = false;
    };
    // isThisSessionLive intentionally excluded — only the initial resolve seeds phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, status, user, router]);

  // Reflect an already-active session (arrived from create / mini-bar).
  useEffect(() => {
    if (isThisSessionLive && phase !== "live") setPhase("live");
  }, [isThisSessionLive, phase]);

  // Room torn down while connected (SERVER_SHUTDOWN / ROOM_DELETED).
  useEffect(() => {
    setOnRoomEnded(() => setPhase("ended"));
  }, [setOnRoomEnded]);

  // Native rooms: poll the upstream participant list so late joiners get their
  // display name / pfp (they arrive over LiveKit as `User <fid>`) and non-LiveKit
  // listeners appear at all. The initial hydrate happens inside `connect`; this
  // keeps it fresh while hosting. Juke-hosted rooms carry identity in LiveKit
  // metadata already, so they skip this.
  useEffect(() => {
    if (!isThisSessionLive || !isNative) return;
    const timer = setInterval(() => void refreshNativeParticipants(), 5000);
    return () => clearInterval(timer);
  }, [isThisSessionLive, isNative, refreshNativeParticipants]);

  const displayRoom = room?.id === id ? room : (detail?.room ?? null);

  const shownParticipants: SessionParticipant[] = useMemo(() => {
    if (isThisSessionLive) return participants;
    return (detail?.participants ?? []).map(toSession);
  }, [isThisSessionLive, participants, detail]);

  const speakers = shownParticipants.filter((p) => SPEAKER_ROLES.has(p.role));
  const listeners = shownParticipants.filter((p) => p.role === "listener");
  const canSpeak = !!myRole && SPEAKER_ROLES.has(myRole);

  // Report host activity to Farcaster every ~30s while producing audio, so a
  // native space isn't auto-ended for "host inactivity" during a piped-audio
  // set (or any web-published audio).
  useNativeHeartbeat({
    active: isThisSessionLive && isNative && canSpeak,
    roomId: room?.id,
    fid: user?.fid,
  });

  // FIP-2 chat root — same contract as the listener view: mint the fallback
  // root cast once live in a Juke-hosted room without one (native rooms mirror
  // theirs from upstream and the endpoint 403s for them).
  const chatTargetAttemptedRoomIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isThisSessionLive || !room) return;
    if (room.status !== "active" || room.cast_hash || room.is_farcaster_native)
      return;
    if (chatTargetAttemptedRoomIdRef.current === room.id) return;
    chatTargetAttemptedRoomIdRef.current = room.id;
    ensureRoomChatTarget(room.id)
      .then((updated) => {
        const current = useSpaceStore.getState().room;
        if (current?.id === updated.id) {
          useSpaceStore.getState().setRoom({ ...current, ...updated });
        }
      })
      .catch(() => {
        // Chat is best-effort — the panel just stays hidden.
      });
  }, [isThisSessionLive, room]);

  const chatCastHash =
    (isThisSessionLive ? room?.cast_hash : null) ??
    detail?.room.cast_hash ??
    null;

  const handleRejoin = useCallback(async () => {
    setPhase("rejoining");
    setError(null);
    const doJoin = () => joinRoom(id);
    try {
      await doJoin();
      setPhase("live");
    } catch (err) {
      // Native rejoin needs an approved app key before the JFS bearer is
      // accepted — surface the Farcaster approval flow, then retry.
      if (err instanceof AppKeyNotApprovedError) {
        setShowApproval(true);
        const approved = await appKey.ensureApproved();
        setShowApproval(false);
        if (!approved) {
          setPhase("preview");
          return;
        }
        try {
          await doJoin();
          setPhase("live");
        } catch (retryErr) {
          setError(
            retryErr instanceof Error
              ? retryErr.message
              : "Couldn't rejoin this space.",
          );
          setPhase("error");
        }
        return;
      }
      setError(
        err instanceof Error ? err.message : "Couldn't rejoin this space.",
      );
      setPhase("error");
    }
  }, [appKey, id, joinRoom]);

  /**
   * Take a native (Farcaster) room live from the host console. Signs a JFS
   * bearer (via `nativeStart`, gated on an approved app key), connects the host
   * to Farcaster's LiveKit with the returned creds, and seeds the session.
   */
  const handleNativeGoLive = useCallback(async () => {
    if (!user || !detail) return;
    // Unlock audio inside the click, before any await, so the host-mic enable
    // in `connect` stays within the user gesture.
    unlockAudioContext();
    setPhase("rejoining");
    setError(null);
    try {
      setShowApproval(true);
      const approved = await appKey.ensureApproved();
      setShowApproval(false);
      if (!approved) {
        setPhase("preview");
        return;
      }
      const { ws_url, token } = await nativeStart(id, user.fid);
      const self: SessionParticipant = {
        fid: user.fid,
        role: "host",
        is_muted: false,
        is_speaking: false,
        hand_raised: false,
        display_name: user.display_name || user.username || `User ${user.fid}`,
        pfp_url: safeImageUrl(user.pfp_url),
      };
      useSpaceStore
        .getState()
        .joinSpace(detail.room as SpaceRoom, [self], "host");
      // `connect` wires the room listeners and auto-enables the host mic. No
      // Juke token to cache — native rooms ride Farcaster's LiveKit.
      await connect(id, token, ws_url);
      setPhase("live");
    } catch (err) {
      setShowApproval(false);
      await useSpaceStore.getState().disconnect();
      setError(err instanceof Error ? err.message : "Couldn't go live.");
      setPhase("error");
    }
  }, [appKey, connect, detail, id, user]);

  const handleLeave = useCallback(async () => {
    await leaveRoom(id);
    router.push("/app");
  }, [id, leaveRoom, router]);

  // ---- Render states -------------------------------------------------------

  if (phase === "loading") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (!displayRoom) {
    return (
      <EmptyState
        title="Space not found"
        description="This space may have ended or the link is invalid."
        action={
          <Button variant="ghost" onClick={() => router.push("/app")}>
            Back to home
          </Button>
        }
      />
    );
  }

  if (phase === "ended") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <HostHeader
          room={displayRoom}
          live={false}
          isHosting={false}
          listenerCount={displayRoom.listener_count}
        />
        <EmptyState
          className="mt-6"
          title="Space ended"
          description="This space has ended."
          action={
            <Button variant="ghost" onClick={() => router.push("/app")}>
              Back to home
            </Button>
          }
        />
      </div>
    );
  }

  // Gate on room identity, NOT `isConnected` — LiveKit flips `isConnected`
  // false during its own silent reconnects, and we must not fall back to the
  // cold "Rejoin as host" bar every time that happens. Once the session is
  // established for this room the console stays live until the room ends
  // (`phase === "ended"`) or the host leaves.
  const showLive = phase === "live" && room?.id === id;
  // Gate host affordances on the ACTUAL connected role, not the room's
  // host_fid guess. For native rooms the authoritative role is only known after
  // native-join seeds `myRole`; a listener who reached this console must not see
  // moderation controls, and the "You're hosting" label must reflect reality.
  const isLiveModerator = showLive && canModerate(myRole);
  // Prefer the live participant list for the listener count once we're hosting;
  // the `detail.room` row is a point-in-time snapshot that reads 0 right after
  // create even as listeners stream in.
  const listenerCount = showLive
    ? listeners.length
    : displayRoom.listener_count;

  return (
    <div className="mx-auto max-w-2xl px-4 pb-40 pt-8">
      <div className="flex items-start justify-between gap-4">
        <HostHeader
          room={displayRoom}
          live={showLive}
          isHosting={isLiveModerator}
          listenerCount={listenerCount}
        />
        {isLiveModerator && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setPanelOpen(true)}
          >
            Host controls
          </Button>
        )}
      </div>

      <section className="mt-8">
        <h2 className="mb-4 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-text-on-dark-tertiary">
          Speakers
        </h2>
        <SpeakerGrid speakers={speakers} />
      </section>

      {listeners.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-4 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-text-on-dark-tertiary">
            Listeners ({listeners.length})
          </h2>
          <ListenerList listeners={listeners} />
        </section>
      )}

      {chatCastHash && (
        <section className="mt-8">
          <h2 className="mb-4 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-text-on-dark-tertiary">
            Chat
          </h2>
          <SpaceChat castHash={chatCastHash} live={isThisSessionLive} />
        </section>
      )}

      {error && phase === "error" && (
        <div
          role="alert"
          className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-center text-sm text-red-300"
        >
          {error}
        </div>
      )}

      {showLive ? (
        <>
          <ReactionsLayer reactions={reactions} />
          <Controls
            canSpeak={canSpeak}
            isMuted={isMuted}
            isHandRaised={false}
            micPermissionDenied={micPermissionDenied}
            onToggleMute={() => void toggleMute()}
            onToggleRaiseHand={() => {}}
            onRetryMic={() => void retryMic()}
            onReact={(key) => void sendReaction(key)}
            onLeave={() => void handleLeave()}
            onOpenSources={() => setSourcesOpen(true)}
          />
          {/* Audio mixer — publishers only (Controls hides the trigger for
              listeners; the open gate double-guards a role demotion). */}
          <AudioSourcesPanel
            open={sourcesOpen && canSpeak}
            onClose={() => setSourcesOpen(false)}
          />
          <Sheet
            open={panelOpen}
            onClose={() => setPanelOpen(false)}
            title="Host controls"
            className="max-h-[85vh] overflow-y-auto"
          >
            <HostPanel
              isNative={isNative}
              onEnded={() => {
                setPanelOpen(false);
                router.push("/app");
              }}
            />
          </Sheet>
        </>
      ) : (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-2xl border-t border-juke-border bg-juke-surface/95 px-4 py-3 backdrop-blur">
          {isNative && !roomIsLive ? (
            <>
              <Button
                fullWidth
                size="lg"
                loading={phase === "rejoining"}
                onClick={() => void handleNativeGoLive()}
              >
                Go live
              </Button>
              <p className="mt-2 text-center text-[11px] text-juke-text-on-dark-tertiary">
                Starts your Farcaster space and opens the host controls.
              </p>
            </>
          ) : (
            <>
              <Button
                fullWidth
                size="lg"
                loading={phase === "rejoining"}
                onClick={() => void handleRejoin()}
              >
                Rejoin as host
              </Button>
              <p className="mt-2 text-center text-[11px] text-juke-text-on-dark-tertiary">
                Reconnects your audio and reopens the host controls.
              </p>
            </>
          )}
        </div>
      )}

      <ApproveAppKeyPrompt
        open={showApproval}
        approvalUrl={appKey.approvalUrl}
        isApproving={appKey.isApproving}
        onClose={() => setShowApproval(false)}
      />
    </div>
  );
}

interface HostHeaderProps {
  room: {
    title: string;
    host: { username: string; display_name: string; pfp_url: string | null };
    listener_count: number;
  };
  live: boolean;
  /** Connected as host/co-host — drives the "You're hosting" label. */
  isHosting: boolean;
  /** Live listener count — reconciled from session state, not the stale row. */
  listenerCount: number;
}

function HostHeader({ room, live, isHosting, listenerCount }: HostHeaderProps) {
  return (
    <header>
      {live && (
        <div className="mb-3 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-orange">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-juke-orange opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-juke-orange" />
          </span>
          {isHosting ? "Live · You're hosting" : "Live"}
        </div>
      )}
      <h1 className="text-2xl font-bold leading-tight text-juke-text-on-dark">
        {room.title}
      </h1>
      <div className="mt-3 flex items-center gap-2 text-sm text-juke-text-on-dark-secondary">
        <Avatar src={room.host.pfp_url} name={room.host.display_name} size="sm" />
        <span>
          @{room.host.username} · {listenerCount}{" "}
          {listenerCount === 1 ? "listener" : "listeners"}
        </span>
      </div>
    </header>
  );
}
