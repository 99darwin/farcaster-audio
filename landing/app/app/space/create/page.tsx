"use client";

/**
 * Create / schedule a space (Stream E).
 *
 * Auth-gated. Mirrors mobile `app/space/create.tsx` (Juke-hosted path) for the
 * web MVP — native Farcaster room creation isn't wired here yet.
 *
 *   - Immediate: `createRoom({ title, announce_cast })` → seed the store as
 *     host (`joinSpace`) → `connect(...)` (auto-enables the host mic inside the
 *     submit gesture) → `attachListeners()` → route to the host console.
 *   - Scheduled: `createRoom({ title, scheduled_at })` → route to the space
 *     detail (no LiveKit connection until it goes live).
 */

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth/AuthProvider";
import { useSpace } from "@/app/app/space/useSpace";
import {
  useSpaceStore,
  type SessionParticipant,
  type SpaceRoom,
} from "@/lib/space/spaceStore";
import { createRoom } from "@/lib/space/spaceApi";
import { nativeCreate } from "@/lib/native/nativeSpaceApi";
import { unlockAudioContext } from "@/lib/space/livekit";
import { safeImageUrl } from "@/lib/safe-url";
import { useAppKey } from "@/components/native/useAppKey";
import { ApproveAppKeyPrompt } from "@/components/native/ApproveAppKeyPrompt";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { ToggleRow } from "@/components/ui/toggle";

const TITLE_MAX = 256;
/** Scheduled spaces must be at least this far in the future. */
const MIN_SCHEDULE_AHEAD_MS = 5 * 60 * 1000;

/** `YYYY-MM-DDTHH:mm` in local time for the datetime-local input default. */
function defaultScheduleLocal(): string {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export default function CreateSpacePage() {
  const router = useRouter();
  const { user, status, signIn } = useAuth();
  const { connect, attachListeners, joinRoom } = useSpace();
  const appKey = useAppKey(user?.fid);

  const [title, setTitle] = useState("");
  const [announceCast, setAnnounceCast] = useState(false);
  const [isScheduled, setIsScheduled] = useState(false);
  const [isNative, setIsNative] = useState(false);
  const [scheduledLocal, setScheduledLocal] = useState(defaultScheduleLocal);
  const [submitting, setSubmitting] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedTitle = title.trim();
  const minScheduleLocal = useMemo(() => defaultScheduleLocal(), []);

  const handleSubmit = useCallback(async () => {
    if (!user) return;
    if (!trimmedTitle) {
      setError("Give your space a title.");
      return;
    }

    let scheduledAtIso: string | undefined;
    if (isScheduled) {
      const when = new Date(scheduledLocal);
      if (Number.isNaN(when.getTime())) {
        setError("Pick a valid date and time.");
        return;
      }
      if (when.getTime() < Date.now() + MIN_SCHEDULE_AHEAD_MS) {
        setError("Scheduled time must be at least 5 minutes from now.");
        return;
      }
      scheduledAtIso = when.toISOString();
    }

    // --- Native Farcaster space path ---
    //
    // Creates the room upstream on Farcaster (signed with the on-device app
    // key, gated on approval) and routes to the host console, which takes it
    // live via `nativeStart`. There is no Juke LiveKit session to seed here.
    if (isNative) {
      // Unlock audio synchronously inside the click (before any await) so the
      // host-mic enable during the immediate go-live connect stays as close to
      // the user gesture as possible.
      if (!isScheduled) unlockAudioContext();
      setSubmitting(true);
      setError(null);
      try {
        setShowApproval(true);
        const approved = await appKey.ensureApproved();
        setShowApproval(false);
        if (!approved) {
          setError("Approve your Farcaster app key to create a native space.");
          setSubmitting(false);
          return;
        }
        // Native rooms are created upstream on Farcaster, which has no
        // announce-cast option — the backend model forbids the field. Mirror
        // mobile's native create and send only the accepted fields.
        const res = await nativeCreate(user.fid, {
          title: trimmedTitle,
          scheduled_at: isScheduled ? scheduledAtIso : undefined,
        });
        // Immediate native rooms are created live upstream, so connect the host
        // NOW (mirrors the Juke path + mobile) and land in the console already
        // hosting — not on a cold "Rejoin as host" prompt. `joinRoom` re-uses
        // the app-key approval we just did (it short-circuits when approved),
        // mints a fresh JFS bearer, native-joins as host, and connects.
        // Scheduled rooms aren't live yet; the console's "Go live" (nativeStart)
        // takes them live, so we just hand off.
        if (!isScheduled) {
          try {
            await joinRoom(res.id);
          } catch {
            // Couldn't auto-connect — don't strand the user on the create form;
            // the host console still offers a "Rejoin as host" affordance.
            await useSpaceStore.getState().disconnect();
          }
        }
        router.replace(`/app/space/host/${res.id}`);
      } catch (err) {
        setShowApproval(false);
        setError(
          err instanceof Error
            ? err.message
            : "Couldn't create your Farcaster space.",
        );
        setSubmitting(false);
      }
      return;
    }

    // Unlock audio synchronously inside the click, before any await, so the
    // host-mic enable in `connect` stays inside the user gesture.
    if (!isScheduled) unlockAudioContext();

    setSubmitting(true);
    setError(null);
    try {
      const response = await createRoom(
        isScheduled
          ? { title: trimmedTitle, scheduled_at: scheduledAtIso }
          : { title: trimmedTitle, announce_cast: announceCast },
      );

      if (isScheduled) {
        router.replace(`/app/space/${response.room.id}`);
        return;
      }

      if (!response.livekit_token || !response.livekit_ws_url) {
        throw new Error("The room was created but no audio session was issued.");
      }

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
        .joinSpace(response.room as SpaceRoom, [self], "host");
      await connect(
        response.room.id,
        response.livekit_token,
        response.livekit_ws_url,
      );
      attachListeners();

      router.replace(`/app/space/host/${response.room.id}`);
    } catch (err) {
      // Roll back any partial session so a failed go-live doesn't strand the
      // mini-bar on a dead room.
      await useSpaceStore.getState().disconnect();
      setError(
        err instanceof Error ? err.message : "Couldn't create your space.",
      );
      setSubmitting(false);
    }
  }, [
    announceCast,
    appKey,
    attachListeners,
    connect,
    isNative,
    isScheduled,
    joinRoom,
    router,
    scheduledLocal,
    trimmedTitle,
    user,
  ]);

  if (status === "loading") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  if (status !== "authenticated" || !user) {
    return (
      <EmptyState
        title="Sign in to host a space"
        description="Connect Farcaster to start a live audio space."
        action={
          <Button onClick={() => void signIn()}>Connect Farcaster</Button>
        }
      />
    );
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-lg flex-col px-4 py-8">
      <h1 className="text-2xl font-bold text-juke-text-on-dark">
        Start a space
      </h1>
      <p className="mt-1 text-sm text-juke-text-on-dark-secondary">
        Host a live audio room for your Farcaster followers.
      </p>

      <form
        className="mt-8 flex flex-1 flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
      >
        <label
          htmlFor="space-title"
          className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-text-on-dark-tertiary"
        >
          Space title
        </label>
        <textarea
          id="space-title"
          value={title}
          onChange={(e) => setTitle(e.target.value.slice(0, TITLE_MAX))}
          placeholder="What do you want to talk about?"
          maxLength={TITLE_MAX}
          rows={2}
          autoFocus
          className="w-full resize-none rounded-xl border border-juke-border bg-juke-surface px-4 py-3 text-base text-juke-text-on-dark placeholder:text-juke-text-on-dark-tertiary focus:border-juke-orange focus:outline-none"
        />
        <span className="mt-1 self-end text-[11px] text-juke-text-on-dark-tertiary">
          {title.length}/{TITLE_MAX}
        </span>

        <ToggleRow
          id="announce-cast"
          label="Announce on Farcaster"
          description="Post a cast so your followers know you're live."
          checked={announceCast}
          disabled={isScheduled || isNative}
          onChange={setAnnounceCast}
          className="mt-4"
        />

        <ToggleRow
          id="native-space"
          label="Native Farcaster space"
          description="Host on Farcaster so it appears natively in the Farcaster app. Needs a one-time app-key approval."
          checked={isNative}
          onChange={setIsNative}
          className="mt-4"
        />

        <ToggleRow
          id="schedule-later"
          label="Schedule for later"
          description="Pick a date and time to go live."
          checked={isScheduled}
          onChange={setIsScheduled}
          className="mt-4"
        />

        {isScheduled && (
          <div className="mt-4">
            <label
              htmlFor="scheduled-at"
              className="mb-2 block font-mono text-[10px] font-semibold uppercase tracking-[0.15em] text-juke-text-on-dark-tertiary"
            >
              Goes live at
            </label>
            <input
              id="scheduled-at"
              type="datetime-local"
              value={scheduledLocal}
              min={minScheduleLocal}
              onChange={(e) => setScheduledLocal(e.target.value)}
              className="w-full rounded-xl border border-juke-border bg-juke-surface px-4 py-3 text-base text-juke-text-on-dark focus:border-juke-orange focus:outline-none [color-scheme:dark]"
            />
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
          >
            {error}
          </div>
        )}

        <div className="mt-auto pt-8">
          <Button
            type="submit"
            fullWidth
            size="lg"
            loading={submitting}
            disabled={!trimmedTitle}
          >
            {isScheduled
              ? "Schedule space"
              : isNative
                ? "Create Farcaster space"
                : "Go live"}
          </Button>
          {!isScheduled && !isNative && (
            <p className="mt-2 text-center text-[11px] text-juke-text-on-dark-tertiary">
              Your browser will ask for microphone access when the room opens.
            </p>
          )}
        </div>
      </form>

      <ApproveAppKeyPrompt
        open={showApproval}
        approvalUrl={appKey.approvalUrl}
        isApproving={appKey.isApproving}
        onClose={() => setShowApproval(false)}
      />
    </div>
  );
}

