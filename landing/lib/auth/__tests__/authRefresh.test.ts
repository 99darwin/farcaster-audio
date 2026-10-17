/**
 * Tests for the single-flight cookie refresh.
 *
 * These assert the two SECURITY controls ported from mobile:
 *   1. Concurrent refreshes collapse to ONE network call (never double-spend
 *      the rotating one-time refresh token).
 *   2. A `sessionGen` change mid-flight discards the response so a stale refresh
 *      can't resurrect a session the user just ended.
 */

import { refreshSession } from "../authRefresh";
import { useAuthStore } from "@/lib/stores/authStore";
import { getUser, clearSession } from "@/lib/auth/session";
import type { LoginResponse } from "@/lib/api/types";

const LOGIN: LoginResponse = {
  jwt: "header.payload.signature",
  refresh_token: null,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  user: {
    fid: 42,
    username: "alice",
    display_name: "Alice",
    pfp_url: null,
    custody_address: null,
    is_pro: false,
    is_admin: false,
  },
};

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const realFetch = global.fetch;

beforeEach(() => {
  clearSession();
  useAuthStore.setState({ user: null, isAuthenticated: false, sessionGen: 0 });
});

afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

describe("refreshSession single-flight", () => {
  test("concurrent calls issue exactly one network request", async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const fetchMock = jest.fn(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const p1 = refreshSession();
    const p2 = refreshSession();

    // Same in-flight promise is handed to both callers.
    expect(p1).toBe(p2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch(makeResponse(200, LOGIN));
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1).toEqual(LOGIN);
    expect(r2).toEqual(LOGIN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });

  test("a second refresh after the first settles issues a new request", async () => {
    const fetchMock = jest.fn(async () => makeResponse(200, LOGIN));
    global.fetch = fetchMock as unknown as typeof fetch;

    await refreshSession();
    await refreshSession();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("refreshSession sessionGen guard", () => {
  test("discards the response when sessionGen changes mid-flight", async () => {
    useAuthStore.setState({ sessionGen: 3 });

    const fetchMock = jest.fn(async () => {
      // Simulate a logout (or newer login) landing while the request is
      // in flight — this is exactly what the guard must defend against.
      useAuthStore.setState({ sessionGen: 4 });
      return makeResponse(200, LOGIN);
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshSession();

    expect(result).toBeNull();
    // applyRefresh must NOT have run — no user, no session.
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(getUser()).toBeNull();
  });
});

describe("refreshSession auth failures", () => {
  test("401 logs out and returns null", async () => {
    useAuthStore.setState({
      user: LOGIN.user,
      isAuthenticated: true,
      sessionGen: 1,
    });
    global.fetch = jest.fn(
      async () => makeResponse(401, { detail: "expired" }),
    ) as unknown as typeof fetch;

    const result = await refreshSession();

    expect(result).toBeNull();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
  });

  test("5xx throws without killing the session (transient)", async () => {
    useAuthStore.setState({
      user: LOGIN.user,
      isAuthenticated: true,
      sessionGen: 1,
    });
    global.fetch = jest.fn(
      async () => makeResponse(503, { detail: "unavailable" }),
    ) as unknown as typeof fetch;

    await expect(refreshSession()).rejects.toThrow(/refresh failed: 503/);
    // Session is left intact for a later retry.
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
  });
});
