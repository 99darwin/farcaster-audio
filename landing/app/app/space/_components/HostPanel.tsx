"use client";

/**
 * Host moderation panel for the web space console (Stream E).
 *
 * Self-contained: reads the live session from `useSpace()` + `useSpaceStore`
 * and drives moderation over REST (`@/lib/space/spaceApi`). Sections:
 *   - Raised hands (hand queue + `hand_raised`) with a promote action.
 *   - Speakers (mute / demote; the host row itself is non-actionable).
 *   - Listeners (promote / kick / ban).
 *   - Recording start/stop (reflects the store's `isRecording`, which the
 *     trusted `space_state` data-channel handler keeps authoritative).
 *   - End space (destructive; confirmed via {@link Modal}).
 *
 * Promote/demote and kick/ban are applied optimistically to the store for a
 * responsive feel and rolled back on REST failure. Kick/ban/end are guarded by
 * a confirm modal.
 */

import { useCallback, useState } from "react";
import { useSpace } from "@/app/app/space/useSpace";
import { useSpaceStore, type SpaceRole } from "@/lib/space/spaceStore";
import {
  muteParticipant,
  kickParticipant,
  banParticipant,
  startRecording,
  stopRecording,
} from "@/lib/space/spaceApi";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";

const SPEAKER_ROLES: ReadonlySet<SpaceRole> = new Set<SpaceRole>([
  "host",
  "co_host",
  "speaker",
]);

const MODERATOR_ROLES: ReadonlySet<SpaceRole> = new Set<SpaceRole>([
  "host",
  "co_host",
]);

interface HostPanelProps {
  /** Called after the space is successfully ended (parent routes away). */
  onEnded: () => void;
  /**
   * Farcaster-native room. Native rooms support promote / demote / end
   * (proxied to Farcaster) and recording (a Juke-owned agent records upstream
   * to S3). Juke-only per-participant moderation (mute, kick, ban) is hidden
   * since there is no Juke participant record to act on.
   */
  isNative?: boolean;
}

type Confirm =
  | { type: "kick"; fid: number; name: string }
  | { type: "ban"; fid: number; name: string }
  | { type: "end" };

export function HostPanel({ onEnded, isNative = false }: HostPanelProps) {
  const {
    room,
    participants,
    handQueue,
    isRecording,
    promoteParticipant,
    demoteParticipant,
    endRoom,
  } = useSpace();

  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roomId = room?.id ?? null;
  const hostFid = room?.host_fid ?? null;

  const raisedHands = participants.filter(
    (p) => handQueue.includes(p.fid) || p.hand_raised,
  );
  const speakers = participants.filter((p) => SPEAKER_ROLES.has(p.role));
  const listeners = participants.filter((p) => p.role === "listener");

  const handlePromote = useCallback(
    async (fid: number) => {
      // Optimistic — reconciled by the metadata-change handler.
      useSpaceStore
        .getState()
        .updateParticipant(fid, { role: "speaker", is_muted: false });
      try {
        await promoteParticipant(fid);
      } catch {
        useSpaceStore
          .getState()
          .updateParticipant(fid, { role: "listener", is_muted: true });
        setError("Couldn't promote that participant.");
      }
    },
    [promoteParticipant],
  );

  const handleDemote = useCallback(
    async (fid: number) => {
      useSpaceStore
        .getState()
        .updateParticipant(fid, { role: "listener", is_muted: true });
      try {
        await demoteParticipant(fid);
      } catch {
        useSpaceStore.getState().updateParticipant(fid, { role: "speaker" });
        setError("Couldn't demote that participant.");
      }
    },
    [demoteParticipant],
  );

  const handleMute = useCallback(
    async (fid: number) => {
      if (!roomId) return;
      useSpaceStore.getState().updateParticipant(fid, { is_muted: true });
      try {
        await muteParticipant(roomId, fid);
      } catch {
        setError("Couldn't mute that participant.");
      }
    },
    [roomId],
  );

  const handleKick = useCallback(
    async (fid: number) => {
      if (!roomId) return;
      setBusy(true);
      try {
        await kickParticipant(roomId, fid);
        useSpaceStore.getState().removeParticipant(fid);
        setConfirm(null);
      } catch {
        setError("Couldn't remove that participant.");
      } finally {
        setBusy(false);
      }
    },
    [roomId],
  );

  const handleBan = useCallback(
    async (fid: number) => {
      if (!roomId) return;
      setBusy(true);
      try {
        await banParticipant(roomId, fid, { reason: "Removed by host" });
        useSpaceStore.getState().removeParticipant(fid);
        setConfirm(null);
      } catch {
        setError("Couldn't ban that participant.");
      } finally {
        setBusy(false);
      }
    },
    [roomId],
  );

  const handleToggleRecording = useCallback(async () => {
    if (!roomId) return;
    const prev = useSpaceStore.getState().isRecording;
    // Optimistic — the trusted `space_state` broadcast reconciles the flag.
    useSpaceStore.getState().setRecording(!prev);
    try {
      if (prev) {
        await stopRecording(roomId);
      } else {
        await startRecording(roomId);
      }
    } catch {
      useSpaceStore.getState().setRecording(prev);
      setError(
        prev ? "Couldn't stop recording." : "Couldn't start recording.",
      );
    }
  }, [roomId]);

  const handleEnd = useCallback(async () => {
    setBusy(true);
    try {
      await endRoom();
      setConfirm(null);
      onEnded();
    } catch {
      setError("Couldn't end the space.");
      setBusy(false);
    }
  }, [endRoom, onEnded]);

  if (!room) return null;

  return (
    <div className="flex flex-col gap-6">
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
        >
          {error}
        </div>
      )}

      {/* Raised hands */}
      {raisedHands.length > 0 && (
        <section>
          <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-text-on-dark-tertiary">
            Raised hands ({raisedHands.length})
          </h3>
          <ul className="flex flex-col divide-y divide-juke-border">
            {raisedHands.map((p) => (
              <li
                key={p.fid}
                className="flex items-center gap-3 py-2.5"
              >
                <Avatar src={p.pfp_url} name={p.display_name} size="sm" />
                <span className="flex-1 truncate text-sm text-juke-text-on-dark">
                  {p.display_name}
                </span>
                {p.fid !== hostFid && (
                  <Button size="sm" onClick={() => void handlePromote(p.fid)}>
                    Invite to speak
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Speakers */}
      <section>
        <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-text-on-dark-tertiary">
          Speakers ({speakers.length})
        </h3>
        <ul className="flex flex-col divide-y divide-juke-border">
          {speakers.map((p) => {
            const isHost = p.fid === hostFid;
            return (
              <li key={p.fid} className="flex items-center gap-3 py-2.5">
                <Avatar src={p.pfp_url} name={p.display_name} size="sm" />
                <span className="flex-1 truncate text-sm text-juke-text-on-dark">
                  {p.display_name}
                  {isHost && (
                    <span className="ml-1.5 text-[11px] text-juke-text-on-dark-tertiary">
                      (Host)
                    </span>
                  )}
                </span>
                {!isHost && (
                  <div className="flex items-center gap-2">
                    {!isNative && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void handleMute(p.fid)}
                      >
                        Mute
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void handleDemote(p.fid)}
                    >
                      Move to listener
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* Listeners */}
      {listeners.length > 0 && (
        <section>
          <h3 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-text-on-dark-tertiary">
            Listeners ({listeners.length})
          </h3>
          <ul className="flex flex-col divide-y divide-juke-border">
            {listeners.map((p) => (
              <li key={p.fid} className="flex items-center gap-3 py-2.5">
                <Avatar src={p.pfp_url} name={p.display_name} size="sm" />
                <span className="flex-1 truncate text-sm text-juke-text-on-dark">
                  {p.display_name}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void handlePromote(p.fid)}
                  >
                    Invite
                  </Button>
                  {!isNative && (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-400 hover:bg-red-500/10"
                        onClick={() =>
                          setConfirm({
                            type: "kick",
                            fid: p.fid,
                            name: p.display_name,
                          })
                        }
                      >
                        Kick
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-red-400 hover:bg-red-500/10"
                        onClick={() =>
                          setConfirm({
                            type: "ban",
                            fid: p.fid,
                            name: p.display_name,
                          })
                        }
                      >
                        Ban
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Recording. Supported for both Juke-hosted rooms (LiveKit egress) and
          Farcaster-native rooms (a Juke-owned recording agent joins upstream
          and mixes to S3). Both hit POST /v1/rooms/{id}/recording/start|stop;
          the backend branches on room type and enforces host-only. */}
      <section className="rounded-xl border border-juke-border bg-juke-navy/40 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold text-juke-text-on-dark">
              {isRecording && (
                <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
              )}
              {isRecording ? "Recording" : "Record space"}
            </p>
            <p className="mt-1 text-xs text-juke-text-on-dark-secondary">
              {isRecording
                ? "Tap stop to end. The recording saves to your profile."
                : "Audio is saved for 30 days and appears on your profile."}
            </p>
          </div>
          <Button
            size="sm"
            variant={isRecording ? "danger" : "secondary"}
            onClick={() => void handleToggleRecording()}
          >
            {isRecording ? "Stop" : "Record"}
          </Button>
        </div>
      </section>

      {/* Danger zone */}
      <section className="border-t border-juke-border pt-4">
        <Button
          fullWidth
          variant="danger"
          onClick={() => setConfirm({ type: "end" })}
        >
          End space
        </Button>
      </section>

      <Modal
        open={confirm !== null}
        onClose={() => !busy && setConfirm(null)}
        title={
          confirm?.type === "end"
            ? "End this space?"
            : confirm?.type === "ban"
              ? "Ban participant?"
              : "Remove participant?"
        }
      >
        <p className="text-sm text-juke-text-on-dark-secondary">
          {confirm?.type === "end"
            ? "This ends the space for everyone. Listeners and speakers will be disconnected."
            : confirm?.type === "ban"
              ? `Ban ${confirm.name} from this space? They won't be able to rejoin.`
              : confirm?.type === "kick"
                ? `Remove ${confirm.name} from this space?`
                : ""}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirm(null)}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => {
              if (!confirm) return;
              if (confirm.type === "end") void handleEnd();
              else if (confirm.type === "kick") void handleKick(confirm.fid);
              else void handleBan(confirm.fid);
            }}
          >
            {confirm?.type === "end"
              ? "End space"
              : confirm?.type === "ban"
                ? "Ban"
                : "Kick"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** Whether a role may open the host panel (host or co-host). */
export function canModerate(role: SpaceRole | null): boolean {
  return role !== null && MODERATOR_ROLES.has(role);
}
