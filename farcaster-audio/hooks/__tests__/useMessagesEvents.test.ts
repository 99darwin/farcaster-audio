import { describe, expect, it, jest } from "@jest/globals";

jest.mock("@/services/storage", () => ({ getTokens: async () => null }));
jest.mock("@/services/authRefresh", () => ({ refreshSession: async () => true }));

import { MessagesApiError } from "@/services/messagesApi";
import {
  classifyClose,
  computeReconnectDelay,
  MESSAGES_WS_DISABLED_CLOSE_CODE,
  MESSAGES_WS_NO_SIGNER_CLOSE_CODE,
  MESSAGES_WS_RATE_LIMITED_CLOSE_CODE,
  MESSAGES_WS_SESSION_EXPIRED_REASON,
  MESSAGES_WS_TICKET_REJECTED_REASON,
  MESSAGES_WS_UNAUTHORIZED_CLOSE_CODE,
  classifyTicketError,
  isSocketSilent,
  parseMessagesEvent,
  RATE_LIMITED_RECONNECT_MS,
  shouldReconnectOnResume,
  STALE_SOCKET_MS,
} from "@/hooks/useMessagesEvents";

const WS_OPEN = 1;
const WS_CLOSED = 3;

describe("classifyClose", () => {
  it("refreshes auth on 4401", () => {
    expect(classifyClose(MESSAGES_WS_UNAUTHORIZED_CLOSE_CODE, "")).toEqual({
      kind: "refresh_auth",
      isSessionExpired: false,
    });
  });

  it("flags a mid-stream session_expired 4401", () => {
    expect(
      classifyClose(MESSAGES_WS_UNAUTHORIZED_CLOSE_CODE, MESSAGES_WS_SESSION_EXPIRED_REASON),
    ).toEqual({ kind: "refresh_auth", isSessionExpired: true });
  });

  it("re-mints without refreshing on a ticket_rejected 4401", () => {
    expect(
      classifyClose(MESSAGES_WS_UNAUTHORIZED_CLOSE_CODE, MESSAGES_WS_TICKET_REJECTED_REASON),
    ).toEqual({ kind: "remint" });
  });

  it.each([
    ["messaging_token_expired", "token_expired"],
    ["messaging_token_rejected", "token_rejected"],
    ["messaging_token_missing", "token_missing"],
    ["", "token_missing"],
    [undefined, "token_missing"],
  ])("stops on 4403 with reason %p -> %p", (reason, accessError) => {
    expect(classifyClose(MESSAGES_WS_NO_SIGNER_CLOSE_CODE, reason)).toEqual({
      kind: "stop_access",
      accessError,
    });
  });

  it("stops and re-probes status on 4404", () => {
    expect(classifyClose(MESSAGES_WS_DISABLED_CLOSE_CODE, "")).toEqual({ kind: "stop_disabled" });
  });

  it("waits at least a minute on 4429 and backs off otherwise", () => {
    expect(classifyClose(MESSAGES_WS_RATE_LIMITED_CLOSE_CODE, "")).toEqual({
      kind: "backoff",
      minDelayMs: RATE_LIMITED_RECONNECT_MS,
    });
    expect(classifyClose(1006, "")).toEqual({ kind: "backoff", minDelayMs: 0 });
    expect(classifyClose(undefined, undefined)).toEqual({ kind: "backoff", minDelayMs: 0 });
  });
});

describe("computeReconnectDelay", () => {
  it("grows exponentially, caps, and honours a floor", () => {
    expect(computeReconnectDelay(0, 0)).toBe(1_000);
    expect(computeReconnectDelay(3, 0)).toBe(8_000);
    expect(computeReconnectDelay(20, 0)).toBe(30_000);
    expect(computeReconnectDelay(0, RATE_LIMITED_RECONNECT_MS)).toBe(RATE_LIMITED_RECONNECT_MS);
  });
});

describe("isSocketSilent", () => {
  const now = 1_000_000;

  it("is true only past the 60 s window", () => {
    expect(isSocketSilent(now - STALE_SOCKET_MS, now)).toBe(false);
    expect(isSocketSilent(now - STALE_SOCKET_MS - 1, now)).toBe(true);
    expect(isSocketSilent(now, now)).toBe(false);
  });
});

describe("shouldReconnectOnResume", () => {
  const now = 1_000_000;

  it("replaces a socket that is not open", () => {
    expect(shouldReconnectOnResume({ readyState: null, lastFrameAt: now, now })).toBe(true);
    expect(shouldReconnectOnResume({ readyState: WS_CLOSED, lastFrameAt: now, now })).toBe(true);
  });

  it("replaces an open socket that has been silent too long (half-open)", () => {
    expect(
      shouldReconnectOnResume({ readyState: WS_OPEN, lastFrameAt: now - STALE_SOCKET_MS - 1, now }),
    ).toBe(true);
    expect(
      shouldReconnectOnResume({ readyState: WS_OPEN, lastFrameAt: now - 1_000, now }),
    ).toBe(false);
  });
});

describe("parseMessagesEvent", () => {
  it("accepts known frames and rejects junk", () => {
    expect(parseMessagesEvent(JSON.stringify({ type: "read", conversation_id: "c1" }))).toEqual({
      type: "read",
      conversation_id: "c1",
    });
    expect(parseMessagesEvent("not json")).toBeNull();
    expect(parseMessagesEvent(JSON.stringify({ type: "other" }))).toBeNull();
  });
});

describe("classifyTicketError", () => {
  it("refreshes auth on a 401 mint", () => {
    expect(classifyTicketError(new MessagesApiError("unauthorized", 401))).toEqual({
      kind: "refresh_auth",
      isSessionExpired: false,
    });
  });

  it("stops when messaging is off and waits a minute when rate limited", () => {
    expect(classifyTicketError(new MessagesApiError("unavailable", 404))).toEqual({
      kind: "stop_disabled",
    });
    expect(classifyTicketError(new MessagesApiError("rate_limited", 429))).toEqual({
      kind: "backoff",
      minDelayMs: RATE_LIMITED_RECONNECT_MS,
    });
  });

  it.each([
    [new MessagesApiError("upstream_error", 502)],
    [new MessagesApiError("network", null)],
    [new Error("boom")],
  ])("backs off on any other failure (%#)", (error) => {
    expect(classifyTicketError(error)).toEqual({ kind: "backoff", minDelayMs: 0 });
  });
});
