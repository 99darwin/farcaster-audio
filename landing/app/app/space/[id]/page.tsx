"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSpace } from "../useSpace";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  getSpaceDetail,
  fetchFarcasterSpace,
  fetchFarcasterSpaceParticipants,
  formatScheduledTime,
  type SpaceDetailResponse,
  type SpaceParticipant,
  type FarcasterNativeSpace,
  type FarcasterNativeSpaceParticipant,
} from "@/lib/spaces";
import {
  useSpaceStore,
  type SessionParticipant,
  type SpaceRole,
} from "@/lib/space/spaceStore";
import { mirrorNativeSpace } from "@/lib/native/nativeSpaceApi";
import { ensureRoomChatTarget } from "@/lib/space/chatApi";
import { AppKeyNotApprovedError } from "@/lib/native/appKeyApproval";
import { useAppKey } from "@/components/native/useAppKey";
import { ApproveAppKeyPrompt } from "@/components/native/ApproveAppKeyPrompt";
import { safeImageUrl } from "@/lib/safe-url";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { SpeakerGrid } from "../_components/SpeakerGrid";
import { ListenerList } from "../_components/ListenerList";
import { Controls } from "../_components/Controls";
import { ReactionsLayer } from "../_components/ReactionsLayer";
import { StageInviteBanner } from "../_components/StageInviteBanner";
import { AudioSourcesPanel } from "../_components/AudioSourcesPanel";
import { useNativeHeartbeat } from "../useNativeHeartbeat";
import { SpaceChat } from "../_components/SpaceChat";

type Phase = "loading" | "preview" | "joining" | "live" | "ended" | "error";

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

export default function SpacePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { user, status, signIn } = useAuth();

  const {
    room,
    participants,
    myRole,
    isConnected,
    isMuted,
    isHandRaised,
    micPermissionDenied,
    reactions,
    pendingStageInvite,
    joinRoom,
    leaveRoom,
    toggleMute,
    retryMic,
    sendReaction,
    toggleRaiseHand,
    acceptStageInvite,
    declineStageInvite,
    setOnRoomEnded,
  } = useSpace();

  const appKey = useAppKey(user?.fid);

  const [detail, setDetail] = useState<SpaceDetailResponse | null>(null);
  const [nativePreview, setNativePreview] =
    useState<FarcasterNativeSpace | null>(null);
  // The Juke room id we actually join. Equals `id` for Juke-hosted / already-
  // mirrored native rooms; set to a freshly-minted mirror id when the URL id is
  // a bare Farcaster room id not yet mirrored into Juke.
  const [joinRoomId, setJoinRoomId] = useState<string | null>(null);
  const [showApproval, setShowApproval] = useState(false);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);

  const sessionRoomId = joinRoomId ?? id;
  const isThisSessionLive = room?.id === sessionRoomId && isConnected;

  // Resolve the room shell for the header / scheduled / native decision.
  //
  // Room-resolution contract: a native space is reachable by EITHER its Juke
  // room id (`getSpaceDetail` returns it, `is_farcaster_native: true`) or its
  // bare Farcaster room id (`getSpaceDetail` 404s → we fall back to the
  // read-only Farcaster space and mirror it into a Juke room on join).
  useEffect(() => {
    let active = true;
    (async () => {
      const data = await getSpaceDetail(id);
      if (!active) return;
      if (data) {
        setDetail(data);
        setJoinRoomId(id);
      } else {
        const fc = await fetchFarcasterSpace(id);
        if (!active) return;
        setNativePreview(fc);
      }
      setPhase((prev) =>
        prev === "loading" ? (isThisSessionLive ? "live" : "preview") : prev,
      );
    })();
    return () => {
      active = false;
    };
    // isThisSessionLive intentionally excluded — only the initial resolve seeds phase.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // A host who lands here — the mini-bar, live/upcoming cards, and the feed all
  // link to this listener route — should get the full host console (mic, host
  // controls, moderation, recording), not the listener "Listen" affordance.
  // Bounce them to the host console once the room resolves and we know they
  // host it. Symmetric with the host console's redirect of non-hosts to this
  // view (=== vs !== guards preclude a redirect loop). Only fires for a
  // resolved Juke room row; an unmirrored native preview has no host-console id
  // yet (its bare Farcaster id would 404 the console), so we leave it alone.
  useEffect(() => {
    if (!detail || !user) return;
    if (detail.room.host_fid === user.fid) {
      router.replace(`/app/space/host/${encodeURIComponent(id)}`);
    }
  }, [detail, user, id, router]);

  // Reflect an already-active session (arrived via the mini-bar).
  useEffect(() => {
    if (isThisSessionLive && phase !== "live") setPhase("live");
  }, [isThisSessionLive, phase]);

  // Host ended the room while we were connected.
  useEffect(() => {
    setOnRoomEnded(() => setPhase("ended"));
  }, [setOnRoomEnded]);

  // Header source: the live session room, else the resolved Juke detail, else a
  // synthesized shell from the read-only Farcaster space (unmirrored native).
  const nativePreviewHeader = useMemo(
    () =>
      nativePreview
        ? {
            title: nativePreview.title || "Farcaster space",
            host: {
              username: nativePreview.host.username ?? "",
              display_name:
                nativePreview.host.display_name ||
                nativePreview.host.username ||
                `User ${nativePreview.host.fid}`,
              pfp_url: safeImageUrl(nativePreview.host.pfp_url),
            },
            listener_count: nativePreview.listener_count ?? 0,
          }
        : null,
    [nativePreview],
  );

  const displayRoom =
    room?.id === sessionRoomId
      ? room
      : (detail?.room ?? nativePreviewHeader ?? null);
  const isNative =
    !!(detail?.room as { is_farcaster_native?: boolean } | null)
      ?.is_farcaster_native || !!nativePreview;
  const isScheduled =
    detail?.room.status === "scheduled" || nativePreview?.state === "scheduled";

  const shownParticipants: SessionParticipant[] = useMemo(() => {
    if (isThisSessionLive) return participants;
    return (detail?.participants ?? []).map(toSession);
  }, [isThisSessionLive, participants, detail]);

  const speakers = shownParticipants.filter((p) => SPEAKER_ROLES.has(p.role));
  const listeners = shownParticipants.filter((p) => p.role === "listener");
  const canSpeak = !!myRole && SPEAKER_ROLES.has(myRole);

  // Promoted speakers on a native space also report activity so a piped-audio
  // (or any published-audio) set isn't auto-ended for host inactivity.
  useNativeHeartbeat({
    active: isThisSessionLive && isNative && canSpeak,
    roomId: room?.id,
    fid: user?.fid,
  });
  // Prefer live participant state for the listener count once connected; the
  // resolved room row is a point-in-time snapshot that can lag the live session.
  const listenerCount = isThisSessionLive
    ? listeners.length
    : displayRoom?.listener_count ?? 0;

  // Pending stage-invite poll (native rooms only). Juke-only listeners don't
  // get Farcaster's push when the host invites them to speak, so we poll the
  // upstream participant list and surface the accept/decline banner. Speakers
  // and non-native sessions skip it entirely.
  const farcasterRoomId = room?.farcaster_room_id ?? null;
  const isSpeaker = !!myRole && SPEAKER_ROLES.has(myRole);
  useEffect(() => {
    if (!isThisSessionLive || !isNative || isSpeaker) return;
    const myFid = user?.fid;
    if (!farcasterRoomId || !myFid) return;

    let active = true;
    const setInvite = useSpaceStore.getState().setPendingStageInvite;
    const tick = async () => {
      try {
        const list = await fetchFarcasterSpaceParticipants(farcasterRoomId);
        if (!active) return;
        const me = list.find((p) => p.user?.fid === myFid) as
          | (FarcasterNativeSpaceParticipant & {
              pending_invite?: { inviter_fid?: number; role?: string };
            })
          | undefined;
        const invite = me?.pending_invite ?? null;
        if (invite) {
          const inviter = invite.inviter_fid
            ? list.find((p) => p.user?.fid === invite.inviter_fid)
            : null;
          setInvite({
            inviterFid: invite.inviter_fid ?? null,
            inviterDisplayName:
              inviter?.user?.display_name || inviter?.user?.username || null,
            inviterPfpUrl: safeImageUrl(inviter?.user?.pfp_url),
            role: String(invite.role || "speaker"),
          });
        } else {
          setInvite(null);
        }
      } catch {
        // Flaky upstream just delays the surface; next tick retries.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
      setInvite(null);
    };
  }, [isThisSessionLive, isNative, isSpeaker, farcasterRoomId, user?.fid]);

  // FIP-2 chat root. Once we're live in a Juke-hosted room with no `cast_hash`,
  // mint the fallback root cast (backend requires the caller to be an active
  // participant). Native rooms mirror their root cast from upstream, and the
  // endpoint 403s for them anyway (no Juke participant record) — skip.
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

  // The chat panel keys off the live session's cast_hash when connected (it
  // may be minted mid-session), else the resolved detail's.
  const chatCastHash =
    (isThisSessionLive ? room?.cast_hash : null) ??
    detail?.room.cast_hash ??
    null;

  const handleJoin = useCallback(async () => {
    if (status !== "authenticated") {
      try {
        await signIn();
      } catch {
        return;
      }
    }
    setPhase("joining");
    setError(null);

    // Resolve the joinable Juke room id. An unmirrored native room (URL id is a
    // bare Farcaster id) is mirrored into a Juke room first; the mint is
    // idempotent so a retry returns the same row.
    let targetId = joinRoomId ?? id;
    if (!joinRoomId && nativePreview && user) {
      try {
        const mirrored = await mirrorNativeSpace({
          farcaster_room_id: id,
          title: nativePreview.title,
          state: nativePreview.state,
          host_fid: nativePreview.host.fid,
        });
        targetId = mirrored.id;
        setJoinRoomId(targetId);
      } catch {
        setError("Couldn't open this Farcaster space.");
        setPhase("error");
        return;
      }
    }

    const doJoin = () => joinRoom(targetId);
    try {
      await doJoin();
      setPhase("live");
    } catch (err) {
      // Native rooms need an approved on-device app key before the JFS bearer
      // will be accepted. Surface the Farcaster approval flow, then retry.
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
              : "Couldn't join this space",
          );
          setPhase("error");
        }
        return;
      }
      setError(err instanceof Error ? err.message : "Couldn't join this space");
      setPhase("error");
    }
  }, [appKey, id, joinRoom, joinRoomId, nativePreview, signIn, status, user]);

  const handleAcceptInvite = useCallback(async () => {
    setInviteBusy(true);
    try {
      await acceptStageInvite();
    } catch {
      // Best-effort; the poll will re-surface the invite if it failed.
    } finally {
      setInviteBusy(false);
    }
  }, [acceptStageInvite]);

  const handleDeclineInvite = useCallback(async () => {
    setInviteBusy(true);
    try {
      await declineStageInvite();
    } catch {
      // Best-effort.
    } finally {
      setInviteBusy(false);
    }
  }, [declineStageInvite]);

  const handleLeave = useCallback(async () => {
    await leaveRoom(id);
    router.push("/app");
  }, [id, leaveRoom, router]);

  const handleRefresh = useCallback(async () => {
    const data = await getSpaceDetail(id);
    setDetail(data);
  }, [id]);

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

  // Scheduled room — starting-soon / RSVP view.
  if (isScheduled && !isThisSessionLive) {
    const rawScheduledAt =
      detail?.room.scheduled_at ?? nativePreview?.scheduled_at ?? null;
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <SpaceHeader room={displayRoom} live={false} listenerCount={listenerCount} />
        <div className="mt-8 rounded-2xl border border-juke-border bg-juke-surface p-6 text-center">
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.15em] text-juke-orange">
            Scheduled
          </p>
          <p className="mt-2 text-lg font-semibold text-juke-text-on-dark">
            {rawScheduledAt
              ? formatScheduledTime(rawScheduledAt, {
                  timeZone: "UTC",
                  showTimezone: true,
                })
              : "Starting soon"}
          </p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-juke-text-on-dark-secondary">
            This space hasn&apos;t started yet. Check back when it goes live.
          </p>
          <div className="mt-5">
            <Button variant="ghost" onClick={handleRefresh}>
              Refresh
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "ended") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <SpaceHeader room={displayRoom} live={false} listenerCount={listenerCount} />
        <EmptyState
          className="mt-6"
          title="Space ended"
          description="The host has ended this space."
          action={
            <Button variant="ghost" onClick={() => router.push("/app")}>
              Back to home
            </Button>
          }
        />
      </div>
    );
  }

  // Live / preview (active Juke-hosted room).
  const showControls = phase === "live" && isThisSessionLive;

  return (
    <div className="mx-auto max-w-2xl px-4 pb-40 pt-8">
      <SpaceHeader room={displayRoom} live listenerCount={listenerCount} />

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

      {status === "authenticated" && chatCastHash && (
        <section className="mt-8">
          <h2 className="mb-4 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-text-on-dark-tertiary">
            Chat
          </h2>
          <SpaceChat castHash={chatCastHash} live={isThisSessionLive} />
        </section>
      )}

      {error && phase === "error" && (
        <div className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-center text-sm text-red-300">
          {error}
        </div>
      )}

      {showControls ? (
        <>
          <ReactionsLayer reactions={reactions} />
          {pendingStageInvite && (
            <StageInviteBanner
              invite={pendingStageInvite}
              busy={inviteBusy}
              onAccept={() => void handleAcceptInvite()}
              onDecline={() => void handleDeclineInvite()}
            />
          )}
          <Controls
            canSpeak={canSpeak}
            isMuted={isMuted}
            isHandRaised={isHandRaised}
            micPermissionDenied={micPermissionDenied}
            onToggleMute={() => void toggleMute()}
            onToggleRaiseHand={() => void toggleRaiseHand()}
            onRetryMic={() => void retryMic()}
            onReact={(key) => void sendReaction(key)}
            onLeave={() => void handleLeave()}
            onOpenSources={() => setSourcesOpen(true)}
          />
          {/* Audio mixer — publishers only (promoted speakers included).
              Controls hides the trigger for listeners; the open gate
              double-guards a mid-session demotion back to listener. */}
          <AudioSourcesPanel
            open={sourcesOpen && canSpeak}
            onClose={() => setSourcesOpen(false)}
          />
        </>
      ) : (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-2xl border-t border-juke-border bg-juke-surface/95 px-4 py-3 backdrop-blur">
          <Button
            fullWidth
            size="lg"
            loading={phase === "joining"}
            onClick={() => void handleJoin()}
          >
            {status !== "authenticated" ? "Sign in to listen" : "Listen"}
          </Button>
          <p className="mt-2 text-center text-[11px] text-juke-text-on-dark-tertiary">
            Audio starts after you tap — your browser may ask for mic access if
            you speak.
          </p>
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

interface SpaceHeaderProps {
  room: {
    title: string;
    host: { username: string; display_name: string; pfp_url: string | null };
    listener_count: number;
  };
  live: boolean;
  /** Live listener count — reconciled from session state, not the stale row. */
  listenerCount: number;
}

function SpaceHeader({ room, live, listenerCount }: SpaceHeaderProps) {
  return (
    <header>
      {live && (
        <div className="mb-3 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-orange">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-juke-orange opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-juke-orange" />
          </span>
          Live
        </div>
      )}
      <h1 className="text-2xl font-bold leading-tight text-juke-text-on-dark">
        {room.title}
      </h1>
      <div className="mt-3 flex items-center gap-2 text-sm text-juke-text-on-dark-secondary">
        <Avatar src={room.host.pfp_url} name={room.host.display_name} size="sm" />
        <span>
          Hosted by @{room.host.username} · {listenerCount}{" "}
          {listenerCount === 1 ? "listener" : "listeners"}
        </span>
      </div>
    </header>
  );
}
