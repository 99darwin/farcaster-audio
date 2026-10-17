/**
 * The nav badge's slow inbox poll, gated on the viewer's Direct Cast token.
 *
 * The badge renders everywhere in the app, including for users who never
 * enabled messaging. Polling `GET /inbox` for them would 403
 * (`messaging_token_missing`) on every tick, so the poll first confirms with
 * the ungated `GET /status` that the token is `active` for the current
 * viewer, and only then loads the inbox. The confirmation is dropped when the
 * viewer changes or the store sees a token error, so the next tick re-checks
 * the status instead of polling blind.
 *
 * Several badge instances can be mounted at once (SideNav + BottomNav), so the
 * poll is ref-counted: only one timer ever runs.
 */

import { isMessagingDisabledError } from "@/lib/api/messages";
import type { MessagingStatus } from "@/lib/api/messages.types";
import type { MessagingAvailability } from "@/lib/stores/messageStore";

export interface BackgroundInboxPollDeps {
  getStatus: () => Promise<MessagingStatus>;
  loadInbox: () => Promise<void>;
  getViewerFid: () => number | null;
  getAvailability: () => MessagingAvailability;
  setAvailability: (availability: MessagingAvailability) => void;
  isVisible: () => boolean;
  intervalMs: number;
}

export interface BackgroundInboxPoll {
  /** Start polling (first retain); returns the matching release. */
  retain: () => () => void;
  /** One poll tick. Exposed for tests. */
  tick: () => Promise<void>;
}

export function createBackgroundInboxPoll(deps: BackgroundInboxPollDeps): BackgroundInboxPoll {
  let retainCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Viewer fid whose token GET /status last reported `active`. */
  let confirmedFid: number | null = null;
  let isCheckingStatus = false;

  /** True once the current viewer's token is confirmed active. */
  async function confirmToken(fid: number): Promise<boolean> {
    if (confirmedFid === fid) return true;
    if (isCheckingStatus) return false;
    isCheckingStatus = true;
    try {
      const status = await deps.getStatus();
      if (!status.enabled) {
        deps.setAvailability("disabled");
        return false;
      }
      if (status.token_status !== "active") {
        if (status.token_status === "missing" || status.token_status === "expired") {
          deps.setAvailability("token_required");
        }
        return false;
      }
      // The account changed while the status was in flight.
      if (deps.getViewerFid() !== fid) return false;
      confirmedFid = fid;
      return true;
    } catch (error) {
      if (isMessagingDisabledError(error)) deps.setAvailability("disabled");
      // Status unreadable: fail closed and re-check on the next tick.
      return false;
    } finally {
      isCheckingStatus = false;
    }
  }

  async function tick(): Promise<void> {
    if (!deps.isVisible()) return;
    const fid = deps.getViewerFid();
    if (fid === null) return;
    const availability = deps.getAvailability();
    if (availability === "disabled") return;
    // A 403 / 4403 since the last check: the token is no longer usable.
    if (availability === "token_required" || confirmedFid !== fid) confirmedFid = null;
    if (!(await confirmToken(fid))) return;
    await deps.loadInbox();
  }

  const runTick = () => {
    void tick();
  };

  function retain(): () => void {
    retainCount += 1;
    if (retainCount === 1) {
      runTick();
      timer = setInterval(runTick, deps.intervalMs);
    }
    let isReleased = false;
    return () => {
      if (isReleased) return;
      isReleased = true;
      retainCount -= 1;
      if (retainCount === 0 && timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
  }

  return { retain, tick };
}
