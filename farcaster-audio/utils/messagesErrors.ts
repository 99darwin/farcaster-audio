/**
 * Routes a messages-API failure to the store state the UI reacts to:
 * token problems open the "Enable messages" gate, a feature-off inbox hides the tab.
 * An `upstream_rejected` 422 is Farcaster refusing this one request, not an
 * outage: it changes no store state.
 * Returns the typed code (or null for aborts) so callers can decide whether
 * to toast.
 */

import {
  MessagesApiError,
  getMessagingStatus,
  isAbortError,
  isSignerError,
  type MessagesErrorCode,
} from "@/services/messagesApi";
import { useMessageStore } from "@/stores/messageStore";

export function applyMessagesError(error: unknown): MessagesErrorCode | null {
  if (isAbortError(error)) return null;
  if (!(error instanceof MessagesApiError)) return "unknown";
  const store = useMessageStore.getState();
  if (isSignerError(error)) {
    store.setAccessError(error.code);
    return error.code;
  }
  if (error.code === "unavailable") {
    store.setAvailability("unavailable");
    void refreshMessagingAvailability();
  }
  return error.code;
}

let availabilityProbe: Promise<void> | null = null;

/**
 * Re-read the feature flag from `GET /status` (ungated, never 404s) after a
 * `messaging_disabled` 404 or a WS 4404 close. Feature off keeps the tab
 * hidden; feature back on clears the flag so the next inbox load restores
 * it. Concurrent callers share one request; a failed probe changes nothing.
 */
export function refreshMessagingAvailability(): Promise<void> {
  if (availabilityProbe) return availabilityProbe;
  availabilityProbe = getMessagingStatus()
    .then((status) => {
      useMessageStore
        .getState()
        .setAvailability(status.enabled ? "unknown" : "unavailable");
    })
    // Best-effort: a failed probe leaves the current availability as is.
    .catch(() => undefined)
    .finally(() => {
      availabilityProbe = null;
    });
  return availabilityProbe;
}

const ERROR_COPY: Record<MessagesErrorCode, string> = {
  unavailable: "Messages aren't available right now.",
  not_found: "That conversation couldn't be found.",
  invalid_recipient: "You can't message yourself.",
  token_missing: "Enable messages to read and send Direct Casts.",
  token_expired: "Your messaging access expired. Enable messages again.",
  token_rejected: "Farcaster no longer accepts your messaging access. Enable messages again.",
  rate_limited: "Slow down a little and try again.",
  upstream_rejected: "Farcaster rejected this message.",
  invalid_cursor: "Those results changed. Showing them from the top.",
  unauthorized: "Your session expired. Sign in again.",
  upstream_error: "Farcaster is having trouble. Try again shortly.",
  network: "You're offline. Check your connection.",
  unknown: "Something went wrong. Try again.",
};

/**
 * User-facing copy for `code`. For `upstream_rejected`, `upstreamMessage`
 * (Farcaster's own reason, sanitized server-side) is appended when present.
 */
export function describeMessagesError(
  code: MessagesErrorCode,
  upstreamMessage: string | null = null,
): string {
  const copy = ERROR_COPY[code];
  if (code !== "upstream_rejected" || !upstreamMessage) return copy;
  return `${copy} ${upstreamMessage}`;
}

/** `applyMessagesError` + `describeMessagesError` in one, for alerts and toasts. */
export function describeMessagesFailure(error: unknown): string | null {
  const code = applyMessagesError(error);
  if (!code) return null;
  const upstreamMessage =
    error instanceof MessagesApiError ? error.upstreamMessage : null;
  return describeMessagesError(code, upstreamMessage);
}
