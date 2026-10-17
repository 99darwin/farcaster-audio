import { getJwt } from "@/lib/auth/session";
import { refreshSession } from "@/lib/auth/authRefresh";
import { ApiFetchError } from "@/lib/api/client";
import { createMessagesEventsTicket } from "@/lib/api/messages";
import {
  CLOSE_DISABLED,
  CLOSE_TOKEN_REQUIRED,
  CLOSE_RATE_LIMITED,
  CLOSE_UNAUTHORIZED,
  MAX_TICKET_REJECTIONS,
  RATE_LIMITED_RECONNECT_MS,
  SESSION_EXPIRED_REASON,
  STALE_SOCKET_MS,
  TICKET_REJECTED_REASON,
  closeAction,
  mintEventsTicket,
  shouldReplaceSocket,
  messagesEventsUrl,
  parseMessagesEvent,
  reconnectDelayMs,
  subscribeToMessageEvents,
} from "@/lib/api/messagesEvents";

jest.mock("@/lib/api/client", () => ({
  ...jest.requireActual("@/lib/api/client"),
  API_BASE_URL: "https://api.example.com",
}));
jest.mock("@/lib/api/messages", () => ({
  ...jest.requireActual("@/lib/api/messages"),
  createMessagesEventsTicket: jest.fn(),
}));
jest.mock("@/lib/auth/session", () => ({ getJwt: jest.fn() }));
jest.mock("@/lib/auth/authRefresh", () => ({ refreshSession: jest.fn() }));

const mockGetJwt = getJwt as jest.MockedFunction<typeof getJwt>;
const mockRefresh = refreshSession as jest.MockedFunction<typeof refreshSession>;
const mockMintTicket = createMessagesEventsTicket as jest.MockedFunction<
  typeof createMessagesEventsTicket
>;
type Session = Awaited<ReturnType<typeof refreshSession>>;

/** Each connect mints a fresh ticket: ticket-1, ticket-2, ... */
let ticketCount = 0;
function mintSequentialTickets() {
  mockMintTicket.mockImplementation(async () => {
    ticketCount += 1;
    return { ticket: `ticket-${ticketCount}`, expires_in: 30 };
  });
}

/** Let the async ticket mint (and any refresh) settle. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Advance fake timers, then let the reconnect's ticket mint settle. */
async function advance(ms: number) {
  jest.advanceTimersByTime(ms);
  await flush();
}

async function subscribe(options: Partial<Parameters<typeof subscribeToMessageEvents>[0]> = {}) {
  const unsubscribe = subscribeToMessageEvents({ onEvent: jest.fn(), ...options });
  await flush();
  return unsubscribe;
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((frame: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
  serverClose(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

const listeners = new Map<string, () => void>();
const fakeTarget = {
  addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  removeEventListener: (type: string) => listeners.delete(type),
};

beforeAll(() => {
  Object.assign(globalThis, {
    window: fakeTarget,
    document: { ...fakeTarget, visibilityState: "visible" },
    WebSocket: FakeWebSocket,
  });
});

afterAll(() => {
  const globals = globalThis as Record<string, unknown>;
  delete globals.window;
  delete globals.document;
  delete globals.WebSocket;
});

beforeEach(() => {
  jest.useFakeTimers();
  FakeWebSocket.instances = [];
  listeners.clear();
  mockGetJwt.mockReturnValue("jwt-1");
  mockRefresh.mockReset();
  mockMintTicket.mockReset();
  ticketCount = 0;
  mintSequentialTickets();
});

afterEach(() => jest.useRealTimers());

describe("parseMessagesEvent", () => {
  it("parses known frames", () => {
    expect(parseMessagesEvent('{"type":"read","conversation_id":"c1"}')).toEqual({
      type: "read",
      conversation_id: "c1",
    });
    expect(parseMessagesEvent({ type: "ping" })).toEqual({ type: "ping" });
  });

  it("rejects malformed and unknown frames", () => {
    expect(parseMessagesEvent("not json")).toBeNull();
    expect(parseMessagesEvent('{"type":"typing","conversation_id":"c1"}')).toBeNull();
    expect(parseMessagesEvent('{"type":"read"}')).toBeNull();
    expect(parseMessagesEvent('{"type":"message","conversation_id":"c1","message":{}}')).toBeNull();
    expect(parseMessagesEvent(null)).toBeNull();
  });
});

describe("helpers", () => {
  it("builds the socket URL with the ticket, never a JWT", () => {
    expect(messagesEventsUrl("a b")).toBe("wss://api.example.com/v1/messages/events?ticket=a%20b");
  });

  it("backs off exponentially with a cap", () => {
    expect([0, 1, 2, 10].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 30000]);
  });
});

describe("mintEventsTicket", () => {
  it("returns the minted ticket", async () => {
    await expect(mintEventsTicket()).resolves.toEqual({ kind: "ticket", ticket: "ticket-1" });
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("gives up with no_session when there is no JWT, without minting", async () => {
    mockGetJwt.mockReturnValue(null);
    await expect(mintEventsTicket()).resolves.toEqual({ kind: "give_up", reason: "no_session" });
    expect(mockMintTicket).not.toHaveBeenCalled();
  });

  it("refreshes once on a 401 and retries", async () => {
    mockMintTicket.mockRejectedValueOnce(new ApiFetchError(401));
    mockRefresh.mockResolvedValue({} as Session);
    await expect(mintEventsTicket()).resolves.toEqual({ kind: "ticket", ticket: "ticket-1" });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockMintTicket).toHaveBeenCalledTimes(2);
  });

  it("reports unauthorized when the retry after a refresh 401s again", async () => {
    mockMintTicket.mockRejectedValue(new ApiFetchError(401));
    mockRefresh.mockResolvedValue({} as Session);
    await expect(mintEventsTicket()).resolves.toEqual({ kind: "give_up", reason: "unauthorized" });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockMintTicket).toHaveBeenCalledTimes(2);
  });

  it("reports no_session when the refresh fails conclusively", async () => {
    mockMintTicket.mockRejectedValueOnce(new ApiFetchError(401));
    mockRefresh.mockResolvedValue(null);
    await expect(mintEventsTicket()).resolves.toEqual({ kind: "give_up", reason: "no_session" });
    expect(mockMintTicket).toHaveBeenCalledTimes(1);
  });

  it("retries later when the refresh fails transiently", async () => {
    mockMintTicket.mockRejectedValueOnce(new ApiFetchError(401));
    mockRefresh.mockRejectedValue(new Error("offline"));
    await expect(mintEventsTicket()).resolves.toEqual({ kind: "retry", minDelayMs: 0 });
  });

  it("maps other failures to backoff, rate limits to a minute, and the flag to disabled", async () => {
    mockMintTicket.mockRejectedValueOnce(new ApiFetchError(502, "upstream_error"));
    await expect(mintEventsTicket()).resolves.toEqual({ kind: "retry", minDelayMs: 0 });
    mockMintTicket.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(mintEventsTicket()).resolves.toEqual({ kind: "retry", minDelayMs: 0 });
    mockMintTicket.mockRejectedValueOnce(new ApiFetchError(429, "rate_limited"));
    await expect(mintEventsTicket()).resolves.toEqual({
      kind: "retry",
      minDelayMs: RATE_LIMITED_RECONNECT_MS,
    });
    mockMintTicket.mockRejectedValueOnce(new ApiFetchError(404, "messaging_disabled"));
    await expect(mintEventsTicket()).resolves.toEqual({ kind: "give_up", reason: "disabled" });
    mockMintTicket.mockResolvedValueOnce({ ticket: "", expires_in: 30 });
    await expect(mintEventsTicket()).resolves.toEqual({ kind: "retry", minDelayMs: 0 });
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});

describe("subscribeToMessageEvents", () => {
  it("delivers events, skips pings and reports open/close", async () => {
    const onEvent = jest.fn();
    const onOpen = jest.fn();
    const onClose = jest.fn();
    const unsubscribe = await subscribe({ onEvent, onOpen, onClose });
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe("wss://api.example.com/v1/messages/events?ticket=ticket-1");

    socket.open();
    socket.onmessage?.({ data: '{"type":"ping"}' });
    socket.onmessage?.({ data: '{"type":"inbox","conversation_id":"c1"}' });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith({ type: "inbox", conversation_id: "c1" });

    jest.advanceTimersByTime(25_000);
    expect(socket.sent).toEqual(['{"type":"ping"}']);

    socket.serverClose(1006);
    expect(onClose).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("never puts the JWT in the socket URL", async () => {
    const unsubscribe = await subscribe();
    expect(FakeWebSocket.instances[0].url).not.toContain("jwt-1");
    expect(FakeWebSocket.instances[0].url).not.toContain("token=");
    unsubscribe();
  });

  it("mints a fresh ticket for every reconnect", async () => {
    const unsubscribe = await subscribe();
    FakeWebSocket.instances[0].serverClose(1006);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await advance(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(mockMintTicket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances[1].url).toContain("ticket=ticket-2");
    unsubscribe();
  });

  it("backs off and retries when minting fails", async () => {
    mockMintTicket.mockRejectedValueOnce(new ApiFetchError(503, "messaging_unavailable"));
    const unsubscribe = await subscribe();
    expect(FakeWebSocket.instances).toHaveLength(0);
    await advance(999);
    expect(FakeWebSocket.instances).toHaveLength(0);
    await advance(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("ticket=ticket-1");
    unsubscribe();
  });

  it("refreshes once when minting 401s, then connects with the new ticket", async () => {
    mockMintTicket.mockRejectedValueOnce(new ApiFetchError(401));
    mockRefresh.mockResolvedValue({} as Session);
    const unsubscribe = await subscribe();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    unsubscribe();
  });

  it("gives up realtime (never signs out) when minting still 401s after a refresh", async () => {
    mockMintTicket.mockRejectedValue(new ApiFetchError(401));
    mockRefresh.mockResolvedValue({} as Session);
    const onUnavailable = jest.fn();
    await subscribe({ onUnavailable });
    expect(onUnavailable).toHaveBeenCalledWith("unauthorized");
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("gives up on 4403 (Direct Cast token unusable)", async () => {
    const onUnavailable = jest.fn();
    const unsubscribe = await subscribe({ onUnavailable });
    FakeWebSocket.instances[0].serverClose(CLOSE_TOKEN_REQUIRED, "messaging_token_expired");
    await advance(60_000);
    expect(onUnavailable).toHaveBeenCalledWith("token_required");
    expect(FakeWebSocket.instances).toHaveLength(1);
    unsubscribe();
  });

  it("retries a 4403 whose reason is the transient decrypt failure", async () => {
    const onUnavailable = jest.fn();
    const unsubscribe = await subscribe({ onUnavailable });
    FakeWebSocket.instances[0].serverClose(CLOSE_TOKEN_REQUIRED, "messaging_token_unavailable");
    await advance(1_000);
    expect(onUnavailable).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
    unsubscribe();
  });

  it("refreshes the session once on 4401 and reconnects with a fresh ticket", async () => {
    mockRefresh.mockResolvedValue({} as Session);
    const unsubscribe = await subscribe();
    FakeWebSocket.instances[0].serverClose(CLOSE_UNAUTHORIZED);
    await flush();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances[1].url).toContain("ticket=ticket-2");
    unsubscribe();
  });

  it("refreshes, re-mints and reconnects on 4401 session_expired", async () => {
    mockRefresh.mockResolvedValue({} as Session);
    const onUnavailable = jest.fn();
    const onOpen = jest.fn();
    const unsubscribe = await subscribe({ onUnavailable, onOpen });
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].serverClose(CLOSE_UNAUTHORIZED, SESSION_EXPIRED_REASON);
    await flush();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockMintTicket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances[1].url).toContain("ticket=ticket-2");
    // The stream comes back, and a later expiry is handled the same way.
    FakeWebSocket.instances[1].open();
    FakeWebSocket.instances[1].serverClose(CLOSE_UNAUTHORIZED, SESSION_EXPIRED_REASON);
    await flush();
    expect(mockRefresh).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(onUnavailable).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("gives up realtime when session_expired repeats right after a refresh", async () => {
    mockRefresh.mockResolvedValue({} as Session);
    const onUnavailable = jest.fn();
    const unsubscribe = await subscribe({ onUnavailable });
    FakeWebSocket.instances[0].serverClose(CLOSE_UNAUTHORIZED, SESSION_EXPIRED_REASON);
    await flush();
    FakeWebSocket.instances[1].serverClose(CLOSE_UNAUTHORIZED, SESSION_EXPIRED_REASON);
    await flush();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith("unauthorized");
    await advance(120_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    unsubscribe();
  });

  it("re-mints with backoff on 4401 ticket_rejected, without refreshing", async () => {
    const onUnavailable = jest.fn();
    const unsubscribe = await subscribe({ onUnavailable });
    FakeWebSocket.instances[0].serverClose(CLOSE_UNAUTHORIZED, TICKET_REJECTED_REASON);
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    await advance(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toContain("ticket=ticket-2");
    // Backoff grows between consecutive rejections.
    FakeWebSocket.instances[1].serverClose(CLOSE_UNAUTHORIZED, TICKET_REJECTED_REASON);
    await advance(1_999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await advance(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("gives up realtime after repeated ticket_rejected closes", async () => {
    const onUnavailable = jest.fn();
    const unsubscribe = await subscribe({ onUnavailable });
    for (let i = 0; i < MAX_TICKET_REJECTIONS; i += 1) {
      FakeWebSocket.instances[i].serverClose(CLOSE_UNAUTHORIZED, TICKET_REJECTED_REASON);
      await advance(60_000);
    }
    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith("unauthorized");
    expect(FakeWebSocket.instances).toHaveLength(MAX_TICKET_REJECTIONS);
    expect(mockRefresh).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("resets the ticket_rejected count once a socket opens", async () => {
    const onUnavailable = jest.fn();
    const unsubscribe = await subscribe({ onUnavailable });
    for (let i = 0; i < MAX_TICKET_REJECTIONS * 2; i += 1) {
      const socket = FakeWebSocket.instances[i];
      if (i % (MAX_TICKET_REJECTIONS - 1) === 0) socket.open();
      socket.serverClose(CLOSE_UNAUTHORIZED, TICKET_REJECTED_REASON);
      await advance(60_000);
    }
    expect(onUnavailable).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("retires a half-open socket from the ping timer while visible", async () => {
    const onClose = jest.fn();
    const unsubscribe = await subscribe({ onClose });
    const first = FakeWebSocket.instances[0];
    first.open();
    // 25s and 50s ticks: silent but not yet stale, so pings go out.
    jest.advanceTimersByTime(50_000);
    expect(first.sent).toHaveLength(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    // 75s tick: > 60s without a frame. No onclose ever fires for it.
    jest.advanceTimersByTime(25_000);
    expect(first.readyState).toBe(3);
    expect(onClose).toHaveBeenCalledTimes(1);
    await advance(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toContain("ticket=ticket-2");
    unsubscribe();
  });

  it("keeps a socket that receives frames between pings", async () => {
    const unsubscribe = await subscribe();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    for (let i = 0; i < 6; i += 1) {
      jest.advanceTimersByTime(25_000);
      socket.onmessage?.({ data: '{"type":"ping"}' });
    }
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.sent).toHaveLength(6);
    unsubscribe();
  });

  it("retries later when the 4401 refresh fails transiently", async () => {
    mockRefresh.mockRejectedValue(new Error("offline"));
    const onUnavailable = jest.fn();
    const unsubscribe = await subscribe({ onUnavailable });
    FakeWebSocket.instances[0].serverClose(CLOSE_UNAUTHORIZED);
    await flush();
    expect(onUnavailable).not.toHaveBeenCalled();
    await advance(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    unsubscribe();
  });

  it("reports no_session without a JWT", async () => {
    mockGetJwt.mockReturnValue(null);
    const onUnavailable = jest.fn();
    await subscribe({ onUnavailable });
    expect(onUnavailable).toHaveBeenCalledWith("no_session");
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(mockMintTicket).not.toHaveBeenCalled();
  });

  it("does not report a superseded socket closing", async () => {
    const onClose = jest.fn();
    const onOpen = jest.fn();
    const unsubscribe = await subscribe({ onOpen, onClose });
    const first = FakeWebSocket.instances[0];
    first.serverClose(1006);
    expect(onClose).toHaveBeenCalledTimes(1);
    await advance(1_000);
    FakeWebSocket.instances[1].open();
    // A late close from the first socket (already replaced) is ignored.
    first.onclose?.({ code: 1006 });
    expect(onClose).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("keeps the live socket's ping timer when a replaced socket closes late", async () => {
    const unsubscribe = await subscribe();
    const first = FakeWebSocket.instances[0];
    first.open();
    jest.advanceTimersByTime(STALE_SOCKET_MS + 1);
    listeners.get("visibilitychange")?.();
    await flush();
    const second = FakeWebSocket.instances[1];
    second.open();
    first.onclose?.({ code: 1006 });
    jest.advanceTimersByTime(25_000);
    expect(second.sent).toEqual(['{"type":"ping"}']);
    unsubscribe();
  });

  it("stops reconnecting after unsubscribe", async () => {
    const unsubscribe = await subscribe();
    unsubscribe();
    FakeWebSocket.instances[0].serverClose(1006);
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(listeners.size).toBe(0);
  });

  it("discards a ticket that arrives after unsubscribe", async () => {
    let resolveTicket: (value: { ticket: string; expires_in: number }) => void = () => {};
    mockMintTicket.mockImplementationOnce(
      () => new Promise((resolve) => { resolveTicket = resolve; }),
    );
    const unsubscribe = await subscribe();
    unsubscribe();
    resolveTicket({ ticket: "late", expires_in: 30 });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("gives up realtime (unauthorized) on a second 4401 after a successful refresh", async () => {
    mockRefresh.mockResolvedValue({} as Session);
    const onUnavailable = jest.fn();
    const unsubscribe = await subscribe({ onUnavailable });
    FakeWebSocket.instances[0].serverClose(CLOSE_UNAUTHORIZED);
    await flush();
    FakeWebSocket.instances[1].serverClose(CLOSE_UNAUTHORIZED);
    await flush();
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(onUnavailable).toHaveBeenCalledWith("unauthorized");
    await advance(60_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
    unsubscribe();
  });

  it("stops on 4404 and reports disabled", async () => {
    const onUnavailable = jest.fn();
    const unsubscribe = await subscribe({ onUnavailable });
    FakeWebSocket.instances[0].serverClose(CLOSE_DISABLED);
    await advance(120_000);
    expect(onUnavailable).toHaveBeenCalledWith("disabled");
    expect(FakeWebSocket.instances).toHaveLength(1);
    unsubscribe();
  });

  it("waits at least a minute after 4429, even across a resume", async () => {
    const unsubscribe = await subscribe();
    FakeWebSocket.instances[0].serverClose(CLOSE_RATE_LIMITED);
    await advance(RATE_LIMITED_RECONNECT_MS - 1);
    listeners.get("online")?.();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    await advance(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    unsubscribe();
  });

  it("waits at least a minute when minting is rate limited", async () => {
    mockMintTicket.mockRejectedValueOnce(new ApiFetchError(429, "rate_limited"));
    const unsubscribe = await subscribe();
    await advance(RATE_LIMITED_RECONNECT_MS - 1);
    listeners.get("online")?.();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(0);
    await advance(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    unsubscribe();
  });

  it("keeps a healthy open socket on resume", async () => {
    const onResume = jest.fn();
    const unsubscribe = await subscribe({ onResume });
    FakeWebSocket.instances[0].open();
    jest.advanceTimersByTime(STALE_SOCKET_MS - 1_000);
    FakeWebSocket.instances[0].onmessage?.({ data: '{"type":"ping"}' });
    jest.advanceTimersByTime(STALE_SOCKET_MS - 1_000);
    listeners.get("visibilitychange")?.();
    await flush();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    unsubscribe();
  });

  it("replaces a socket that has been silent too long on resume, reporting the gap", async () => {
    const onClose = jest.fn();
    const unsubscribe = await subscribe({ onClose });
    FakeWebSocket.instances[0].open();
    jest.advanceTimersByTime(STALE_SOCKET_MS + 1);
    listeners.get("visibilitychange")?.();
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toContain("ticket=ticket-2");
    unsubscribe();
  });

  it("replaces a socket stuck connecting on resume", async () => {
    const unsubscribe = await subscribe();
    listeners.get("online")?.();
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(2);
    unsubscribe();
  });

  it("does not start a second mint when resuming mid-mint", async () => {
    let resolveTicket: (value: { ticket: string; expires_in: number }) => void = () => {};
    mockMintTicket.mockImplementationOnce(
      () => new Promise((resolve) => { resolveTicket = resolve; }),
    );
    const unsubscribe = await subscribe();
    listeners.get("online")?.();
    await flush();
    expect(mockMintTicket).toHaveBeenCalledTimes(1);
    resolveTicket({ ticket: "slow", expires_in: 30 });
    await flush();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain("ticket=slow");
    unsubscribe();
  });
});

describe("closeAction", () => {
  it("maps design doc 4.7 close codes", () => {
    expect(closeAction(CLOSE_UNAUTHORIZED, false)).toEqual({ kind: "refresh_auth" });
    expect(closeAction(CLOSE_UNAUTHORIZED, true)).toEqual({ kind: "give_up", reason: "unauthorized" });
    expect(closeAction(CLOSE_UNAUTHORIZED, false, SESSION_EXPIRED_REASON)).toEqual({ kind: "refresh_auth" });
    expect(closeAction(CLOSE_UNAUTHORIZED, true, SESSION_EXPIRED_REASON)).toEqual({
      kind: "give_up",
      reason: "unauthorized",
    });
    // A rejected ticket re-mints without a refresh, even after an auth retry.
    expect(closeAction(CLOSE_UNAUTHORIZED, false, TICKET_REJECTED_REASON)).toEqual({ kind: "remint" });
    expect(closeAction(CLOSE_UNAUTHORIZED, true, TICKET_REJECTED_REASON)).toEqual({ kind: "remint" });
    expect(closeAction(CLOSE_TOKEN_REQUIRED, false, "messaging_token_rejected")).toEqual({
      kind: "give_up",
      reason: "token_required",
    });
    expect(closeAction(CLOSE_TOKEN_REQUIRED, false, "messaging_token_unavailable")).toEqual({
      kind: "reconnect",
      minDelayMs: 0,
    });
    expect(closeAction(CLOSE_DISABLED, false)).toEqual({ kind: "give_up", reason: "disabled" });
    expect(closeAction(CLOSE_RATE_LIMITED, false)).toEqual({
      kind: "reconnect",
      minDelayMs: RATE_LIMITED_RECONNECT_MS,
    });
    for (const code of [1000, 1001, 1006, 1011]) {
      expect(closeAction(code, false)).toEqual({ kind: "reconnect", minDelayMs: 0 });
    }
  });

  it("replaces non-open or stale sockets", () => {
    expect(shouldReplaceSocket(null, 0, 0)).toBe(true);
    expect(shouldReplaceSocket(0, 0, 0)).toBe(true);
    expect(shouldReplaceSocket(1, 0, STALE_SOCKET_MS)).toBe(false);
    expect(shouldReplaceSocket(1, 0, STALE_SOCKET_MS + 1)).toBe(true);
  });
});
