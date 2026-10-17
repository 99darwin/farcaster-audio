/**
 * Connect flow of `useMessagesEvents`: every (re)connect mints a single-use
 * ticket first and the JWT never rides in the socket URL (design §4.2, §4.7).
 * Auth failures recover or give up realtime; the socket never signs out.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import type { MessagesEventsTicket } from "@/types/messages";

const mockCreateTicket = jest.fn<() => Promise<MessagesEventsTicket>>();
const mockRefreshSession = jest.fn<() => Promise<unknown>>();
const mockLogout = jest.fn<() => Promise<void>>();
const JWT = "header.payload.signature";

jest.mock("@/services/messagesApi", () => {
  const actual = jest.requireActual("@/services/messagesApi") as Record<string, unknown>;
  return { ...actual, createMessagesEventsTicket: () => mockCreateTicket() };
});
jest.mock("@/services/storage", () => ({
  getTokens: async () => ({ jwt: JWT, refreshToken: "refresh" }),
}));
jest.mock("@/services/authRefresh", () => ({ refreshSession: () => mockRefreshSession() }));
jest.mock("@/stores/authStore", () => ({
  useAuthStore: { getState: () => ({ logout: () => mockLogout() }) },
}));
jest.mock("@/constants/config", () => ({ Config: { API_BASE_URL: "https://api.test" } }));

import {
  MAX_AUTH_RECOVERY_FAILURES,
  MESSAGES_WS_SESSION_EXPIRED_REASON,
  MESSAGES_WS_TICKET_REJECTED_REASON,
  MESSAGES_WS_UNAUTHORIZED_CLOSE_CODE,
  STALE_SOCKET_MS,
  useMessagesEvents,
} from "@/hooks/useMessagesEvents";
import { MessagesApiError } from "@/services/messagesApi";
import { useMessageStore } from "@/stores/messageStore";

let appStateListener: ((state: AppStateStatus) => void) | null = null;
const realtimeStatus = () => useMessageStore.getState().realtimeStatus;

class MockWebSocket {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  serverClose(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

/** Let pending promise chains (getTokens -> mint -> new WebSocket) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
  await flush();
}

const ticket = (value: string): MessagesEventsTicket => ({ ticket: value, expires_in: 30 });

beforeEach(() => {
  jest.useFakeTimers();
  MockWebSocket.instances = [];
  mockCreateTicket.mockReset();
  mockRefreshSession.mockReset();
  mockLogout.mockReset();
  mockLogout.mockResolvedValue(undefined);
  useMessageStore.getState().reset();
  appStateListener = null;
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => {
    appStateListener = listener as (state: AppStateStatus) => void;
    return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    writable: true,
    value: MockWebSocket,
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("useMessagesEvents connect", () => {
  it("connects with a freshly minted ticket and no JWT in the URL", async () => {
    mockCreateTicket.mockResolvedValueOnce(ticket("t-1"));
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    expect(mockCreateTicket).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    const { url } = MockWebSocket.instances[0];
    expect(url).toBe("wss://api.test/v1/messages/events?ticket=t-1");
    expect(url).not.toContain(JWT);
    expect(url).not.toContain("token=");
    unmount();
  });

  it("mints a new ticket for every reconnect", async () => {
    mockCreateTicket
      .mockResolvedValueOnce(ticket("t-1"))
      .mockResolvedValueOnce(ticket("t-2"));
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].serverClose(1006);
    await advance(1_000);
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances[1].url).toContain("ticket=t-2");
    unmount();
  });

  it("refreshes once on a 401 mint, then retries the mint", async () => {
    mockCreateTicket
      .mockRejectedValueOnce(new MessagesApiError("unauthorized", 401))
      .mockResolvedValueOnce(ticket("t-after-refresh"));
    mockRefreshSession.mockResolvedValue({ jwt: "fresh" });
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(0);
    await advance(1_000);
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances[0].url).toContain("ticket=t-after-refresh");
    expect(mockLogout).not.toHaveBeenCalled();
    unmount();
  });

  it("never signs out when the mint is still 401 after the refresh: backs off, then gives up realtime", async () => {
    mockCreateTicket.mockRejectedValue(new MessagesApiError("unauthorized", 401));
    mockRefreshSession.mockResolvedValue({ jwt: "fresh" });
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    expect(realtimeStatus()).toBe("reconnecting");
    // Still 401 on the refreshed JWT: exponential backoff, no second refresh.
    await advance(1_999);
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mockCreateTicket).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 6; i += 1) await advance(30_000);
    expect(mockCreateTicket).toHaveBeenCalledTimes(1 + MAX_AUTH_RECOVERY_FAILURES);
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    expect(realtimeStatus()).toBe("disconnected");
    await advance(60_000);
    expect(mockCreateTicket).toHaveBeenCalledTimes(1 + MAX_AUTH_RECOVERY_FAILURES);
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(mockLogout).not.toHaveBeenCalled();
    unmount();
  });

  it("retries the refresh with backoff when it fails transiently, without signing out", async () => {
    mockCreateTicket.mockRejectedValue(new MessagesApiError("unauthorized", 401));
    mockRefreshSession.mockRejectedValue(new Error("Network request failed"));
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    await advance(999);
    expect(mockCreateTicket).toHaveBeenCalledTimes(1);
    await advance(1);
    // The flag was reset, so the next 401 refreshes again.
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    expect(mockRefreshSession).toHaveBeenCalledTimes(2);
    await advance(1_999);
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mockCreateTicket).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 6; i += 1) await advance(30_000);
    expect(mockRefreshSession).toHaveBeenCalledTimes(MAX_AUTH_RECOVERY_FAILURES);
    expect(realtimeStatus()).toBe("disconnected");
    expect(mockLogout).not.toHaveBeenCalled();
    unmount();
  });

  it("stops without reconnecting when the refresh ended the session", async () => {
    mockCreateTicket.mockRejectedValue(new MessagesApiError("unauthorized", 401));
    mockRefreshSession.mockResolvedValue(null);
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    await advance(60_000);
    expect(mockCreateTicket).toHaveBeenCalledTimes(1);
    expect(realtimeStatus()).toBe("disconnected");
    // services/api's refresh path owns the sign-out, not the socket.
    expect(mockLogout).not.toHaveBeenCalled();
    unmount();
  });

  it("retries realtime from scratch on foreground after giving up", async () => {
    mockCreateTicket.mockRejectedValue(new MessagesApiError("unauthorized", 401));
    mockRefreshSession.mockResolvedValue({ jwt: "fresh" });
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    for (let i = 0; i < 8; i += 1) await advance(30_000);
    expect(realtimeStatus()).toBe("disconnected");
    const mintsBefore = mockCreateTicket.mock.calls.length;

    mockCreateTicket.mockReset();
    mockCreateTicket.mockResolvedValue(ticket("t-back"));
    await act(async () => appStateListener?.("active"));
    await flush();
    expect(MockWebSocket.instances[0].url).toContain("ticket=t-back");
    MockWebSocket.instances[0].open();
    expect(realtimeStatus()).toBe("connected");
    expect(mintsBefore).toBe(1 + MAX_AUTH_RECOVERY_FAILURES);
    unmount();
  });

  it("on 4401 ticket_rejected mints a fresh ticket without refreshing", async () => {
    mockCreateTicket
      .mockResolvedValueOnce(ticket("t-1"))
      .mockResolvedValueOnce(ticket("t-2"));
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    MockWebSocket.instances[0].serverClose(
      MESSAGES_WS_UNAUTHORIZED_CLOSE_CODE,
      MESSAGES_WS_TICKET_REJECTED_REASON,
    );
    await advance(1_000);
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances[1].url).toContain("ticket=t-2");
    expect(mockRefreshSession).not.toHaveBeenCalled();
    expect(mockLogout).not.toHaveBeenCalled();
    unmount();
  });

  it("closes a socket silent for more than 60s and reconnects", async () => {
    mockCreateTicket
      .mockResolvedValueOnce(ticket("t-1"))
      .mockResolvedValueOnce(ticket("t-2"));
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    const first = MockWebSocket.instances[0];
    first.open();
    expect(realtimeStatus()).toBe("connected");
    // Pings go out while the socket is within the silence window.
    await advance(STALE_SOCKET_MS);
    expect(first.sent.length).toBeGreaterThan(0);
    expect(first.readyState).toBe(MockWebSocket.OPEN);
    // The next keepalive tick sees > 60 s without a frame.
    await advance(25_000);
    expect(first.readyState).toBe(3);
    expect(realtimeStatus()).toBe("reconnecting");
    await advance(1_000);
    expect(MockWebSocket.instances[1].url).toContain("ticket=t-2");
    unmount();
  });

  it("keeps a socket that receives frames", async () => {
    mockCreateTicket.mockResolvedValueOnce(ticket("t-1"));
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    const first = MockWebSocket.instances[0];
    first.open();
    for (let i = 0; i < 6; i += 1) {
      await advance(20_000);
      first.onmessage?.({ data: JSON.stringify({ type: "ping" }) });
    }
    expect(first.readyState).toBe(MockWebSocket.OPEN);
    expect(MockWebSocket.instances).toHaveLength(1);
    unmount();
  });

  it("puts other mint failures through the normal backoff without refreshing", async () => {
    mockCreateTicket
      .mockRejectedValueOnce(new MessagesApiError("upstream_error", 502))
      .mockRejectedValueOnce(new MessagesApiError("network", null))
      .mockResolvedValueOnce(ticket("t-3"));
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    await advance(999);
    expect(mockCreateTicket).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    // Second failure doubles the wait.
    await advance(1_999);
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(MockWebSocket.instances[0].url).toContain("ticket=t-3");
    expect(mockRefreshSession).not.toHaveBeenCalled();
    unmount();
  });

  it("on 4401 session_expired refreshes the JWT, mints a fresh ticket and reconnects", async () => {
    mockCreateTicket
      .mockResolvedValueOnce(ticket("t-1"))
      .mockResolvedValueOnce(ticket("t-2"))
      .mockResolvedValueOnce(ticket("t-3"));
    mockRefreshSession.mockResolvedValue({ jwt: "fresh" });
    const { unmount } = renderHook(() => useMessagesEvents(true, () => {}));
    await flush();
    MockWebSocket.instances[0].open();
    MockWebSocket.instances[0].serverClose(
      MESSAGES_WS_UNAUTHORIZED_CLOSE_CODE,
      MESSAGES_WS_SESSION_EXPIRED_REASON,
    );
    await flush();
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(mockCreateTicket).toHaveBeenCalledTimes(2);
    expect(MockWebSocket.instances[1].url).toContain("ticket=t-2");

    // The next expiry, after a healthy reconnect, refreshes again rather
    // than signing out.
    MockWebSocket.instances[1].open();
    MockWebSocket.instances[1].serverClose(
      MESSAGES_WS_UNAUTHORIZED_CLOSE_CODE,
      MESSAGES_WS_SESSION_EXPIRED_REASON,
    );
    await flush();
    expect(mockRefreshSession).toHaveBeenCalledTimes(2);
    expect(mockLogout).not.toHaveBeenCalled();
    unmount();
  });
});
