/**
 * Embed SDK auth: Mini App Protocol Auth first, the web auth-address flow
 * (PR #322) as the fallback, and session renewal per source. The auth
 * modules are mocked; their own behaviour is covered next to them.
 */

const mockGetCachedMiniappAuth = jest.fn();
const mockAuthenticateMiniapp = jest.fn();
const mockClearCachedMiniappAuth = jest.fn();
const mockSignInReturningBrowser = jest.fn();
const mockOpenEmbedSignInPopup = jest.fn();
const mockStore = { kind: "test-store" };

jest.mock("livekit-client", () => ({
  Room: jest.fn(),
  RoomEvent: {},
  Track: { Kind: { Audio: "audio" } },
}));

jest.mock("@/lib/miniapp-auth", () => ({
  getCachedMiniappAuth: () => mockGetCachedMiniappAuth(),
  authenticateMiniapp: (...args: unknown[]) => mockAuthenticateMiniapp(...args),
  clearCachedMiniappAuth: () => mockClearCachedMiniappAuth(),
}));

jest.mock("@/lib/auth/webSignIn", () => ({
  signInReturningBrowser: (...args: unknown[]) => mockSignInReturningBrowser(...args),
}));

jest.mock("@/lib/embed-sign-in-popup", () => ({
  ...jest.requireActual("@/lib/embed-sign-in-popup"),
  openEmbedSignInPopup: (...args: unknown[]) => mockOpenEmbedSignInPopup(...args),
}));

jest.mock("@/lib/auth/authAddressStore", () => ({
  getBrowserAuthAddressStore: () => mockStore,
}));

jest.mock("@/lib/spaces", () => ({
  API_BASE_URL: "https://api.test",
  getSpaceDetail: jest.fn(),
}));

import { LOGIN_RESPONSE, TEST_FID } from "@/lib/auth/__tests__/fixtures";
import {
  createJukeEmbedSdk,
  EMBED_AUTH_OPTIONS,
  EmbedSignInPopupError,
  JukeEmbedAuthError,
} from "@/lib/juke-embed-sdk";

const HOUR_MS = 60 * 60 * 1000;
const SPACE_ID = "space-uuid";

function joinResponseBody() {
  return { room: { id: SPACE_ID }, participants: [], role: "listener" };
}

function stubFetch(
  routes: Record<string, (init: RequestInit) => { status: number; body: unknown }>,
) {
  return jest
    .spyOn(global, "fetch")
    .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const route = routes[`${init?.method ?? "GET"} ${url.pathname}`];
      if (!route) return new Response("{}", { status: 404 });
      const { status, body } = route(init ?? {});
      return new Response(JSON.stringify(body), { status });
    });
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockGetCachedMiniappAuth.mockReset();
  mockAuthenticateMiniapp.mockReset();
  mockClearCachedMiniappAuth.mockReset();
  mockSignInReturningBrowser.mockReset();
  mockOpenEmbedSignInPopup.mockReset();
});

describe("public API", () => {
  it("no longer exposes the relay helpers", () => {
    const sdk = createJukeEmbedSdk() as unknown as Record<string, unknown>;
    expect(sdk.startSiwfFlow).toBeUndefined();
    expect(sdk.pollSiwfStatus).toBeUndefined();
  });

  it("never collects a recovery phrase itself", () => {
    const sdk = createJukeEmbedSdk() as unknown as Record<string, unknown>;
    expect(sdk.linkBrowser).toBeUndefined();
  });

  it("asks the web flow for body refresh tokens", () => {
    expect(EMBED_AUTH_OPTIONS).toEqual({ useCookie: false });
    expect(Object.isFrozen(EMBED_AUTH_OPTIONS)).toBe(true);
  });
});

describe("signInWithMiniApp", () => {
  it("adopts the host-signed session", async () => {
    const expiresAt = Date.now() + HOUR_MS;
    mockGetCachedMiniappAuth.mockResolvedValue({
      ok: true,
      token: "miniapp-jwt",
      fid: TEST_FID,
      expiresAt,
    });
    const sdk = createJukeEmbedSdk();

    const session = await sdk.signInWithMiniApp();

    expect(session).toEqual({
      jwt: "miniapp-jwt",
      refreshToken: "",
      expiresAt: new Date(expiresAt).toISOString(),
      fid: TEST_FID,
      source: "miniapp",
    });
    expect(sdk.isAuthenticated).toBe(true);
    expect(sdk.authenticatedFid).toBe(TEST_FID);
  });

  it("returns null outside a Mini App host so the caller can fall back", async () => {
    mockGetCachedMiniappAuth.mockResolvedValue({ ok: false, reason: "not_in_miniapp" });
    const sdk = createJukeEmbedSdk();

    await expect(sdk.signInWithMiniApp()).resolves.toBeNull();
    expect(sdk.isAuthenticated).toBe(false);
  });

  it.each(["verify_failed", "user_cancelled", "network", "invalid_response", "timeout"])(
    "throws JukeEmbedAuthError carrying the %s reason",
    async (reason) => {
      mockGetCachedMiniappAuth.mockResolvedValue({ ok: false, reason });
      const sdk = createJukeEmbedSdk();

      const error = await sdk.signInWithMiniApp().catch((err: unknown) => err);

      expect(error).toBeInstanceOf(JukeEmbedAuthError);
      expect((error as JukeEmbedAuthError).reason).toBe(reason);
      expect(sdk.isAuthenticated).toBe(false);
    },
  );

  it("bypasses the cache when forced", async () => {
    mockAuthenticateMiniapp.mockResolvedValue({
      ok: true,
      token: "fresh-jwt",
      fid: TEST_FID,
      expiresAt: Date.now() + HOUR_MS,
    });
    const sdk = createJukeEmbedSdk();

    await sdk.signInWithMiniApp({ force: true });

    expect(mockClearCachedMiniappAuth).toHaveBeenCalled();
    // `force` reaches the host SDK, so renewal gets a new token rather than
    // the SDK's cached one (which would mint an equally short session).
    expect(mockAuthenticateMiniapp).toHaveBeenCalledWith({ force: true });
    expect(mockGetCachedMiniappAuth).not.toHaveBeenCalled();
  });
});

describe("web auth-address fallback", () => {
  it("signs in a returning browser with body refresh tokens", async () => {
    mockSignInReturningBrowser.mockResolvedValue({
      ...LOGIN_RESPONSE,
      refresh_token: "refresh-1",
    });
    const sdk = createJukeEmbedSdk();

    const session = await sdk.signInWithAuthAddress(TEST_FID);

    expect(mockSignInReturningBrowser).toHaveBeenCalledWith(
      { fid: TEST_FID, store: mockStore },
      { useCookie: false },
    );
    expect(session).toMatchObject({
      jwt: LOGIN_RESPONSE.jwt,
      refreshToken: "refresh-1",
      fid: TEST_FID,
      source: "protocol",
    });
  });

  it("adopts the session the first-party popup hands back", async () => {
    mockOpenEmbedSignInPopup.mockResolvedValue({
      ...LOGIN_RESPONSE,
      refresh_token: "refresh-2",
    });
    const controller = new AbortController();
    const sdk = createJukeEmbedSdk();

    const session = await sdk.signInWithPopup({ signal: controller.signal });

    expect(mockOpenEmbedSignInPopup).toHaveBeenCalledWith({
      signal: controller.signal,
    });
    expect(session).toMatchObject({
      refreshToken: "refresh-2",
      fid: TEST_FID,
      source: "protocol",
    });
  });

  it("opens the popup before yielding, so it stays inside the click", () => {
    mockOpenEmbedSignInPopup.mockReturnValue(new Promise(() => {}));
    const sdk = createJukeEmbedSdk();

    void sdk.signInWithPopup();

    expect(mockOpenEmbedSignInPopup).toHaveBeenCalledTimes(1);
  });

  it("surfaces a blocked or closed popup without signing in", async () => {
    mockOpenEmbedSignInPopup.mockRejectedValue(new EmbedSignInPopupError("closed"));
    const sdk = createJukeEmbedSdk();

    await expect(sdk.signInWithPopup()).rejects.toMatchObject({ reason: "closed" });
    expect(sdk.isAuthenticated).toBe(false);
  });

  it("rejects a malformed login response", () => {
    const sdk = createJukeEmbedSdk();
    expect(() =>
      sdk.adoptLoginResponse({ ...LOGIN_RESPONSE, jwt: "" }),
    ).toThrow(JukeEmbedAuthError);
    expect(sdk.isAuthenticated).toBe(false);
  });
});

describe("session renewal", () => {
  it("re-signs an expiring Mini App session with the host wallet", async () => {
    mockGetCachedMiniappAuth.mockResolvedValue({
      ok: true,
      token: "stale-jwt",
      fid: TEST_FID,
      expiresAt: Date.now() + 1000,
    });
    mockAuthenticateMiniapp.mockResolvedValue({
      ok: true,
      token: "fresh-jwt",
      fid: TEST_FID,
      expiresAt: Date.now() + HOUR_MS,
    });
    const authHeaders: string[] = [];
    const fetchSpy = stubFetch({
      [`POST /v1/rooms/${SPACE_ID}/join`]: (init) => {
        authHeaders.push(
          (init.headers as Record<string, string>).Authorization ?? "",
        );
        return { status: 200, body: joinResponseBody() };
      },
    });
    const sdk = createJukeEmbedSdk();
    await sdk.signInWithMiniApp();

    await sdk.joinAuthenticated(SPACE_ID);

    expect(mockAuthenticateMiniapp).toHaveBeenCalledTimes(1);
    expect(mockAuthenticateMiniapp).toHaveBeenCalledWith({ force: true });
    expect(authHeaders).toEqual(["Bearer fresh-jwt"]);
    // A Mini App session never calls /v1/auth/refresh.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("signs the visitor out when the host can no longer sign", async () => {
    mockGetCachedMiniappAuth.mockResolvedValue({
      ok: true,
      token: "stale-jwt",
      fid: TEST_FID,
      expiresAt: Date.now() + 1000,
    });
    mockAuthenticateMiniapp.mockResolvedValue({ ok: false, reason: "not_in_miniapp" });
    const sdk = createJukeEmbedSdk();
    await sdk.signInWithMiniApp();

    await expect(sdk.joinAuthenticated(SPACE_ID)).rejects.toBeInstanceOf(
      JukeEmbedAuthError,
    );
    expect(sdk.isAuthenticated).toBe(false);
  });

  it("refreshes a web session with the body refresh token", async () => {
    const refreshBodies: unknown[] = [];
    stubFetch({
      "POST /v1/auth/refresh": (init) => {
        refreshBodies.push(JSON.parse(String(init.body)));
        return {
          status: 200,
          body: {
            ...LOGIN_RESPONSE,
            jwt: "renewed-jwt",
            refresh_token: "refresh-rotated",
            expires_at: new Date(Date.now() + HOUR_MS).toISOString(),
          },
        };
      },
      [`POST /v1/rooms/${SPACE_ID}/join`]: () => ({
        status: 200,
        body: joinResponseBody(),
      }),
    });
    const sdk = createJukeEmbedSdk();
    sdk.adoptLoginResponse({
      ...LOGIN_RESPONSE,
      refresh_token: "refresh-original",
      expires_at: new Date(Date.now() + 1000).toISOString(),
    });

    await sdk.joinAuthenticated(SPACE_ID);

    expect(refreshBodies).toEqual([{ refresh_token: "refresh-original" }]);
    const raiseHandSpy = stubFetch({
      [`POST /v1/rooms/${SPACE_ID}/raise-hand`]: (init) => ({
        status: 200,
        body: {
          hand_raised: true,
          queue_position: 1,
          auth: (init.headers as Record<string, string>).Authorization,
        },
      }),
    });
    await expect(sdk.raiseHand(SPACE_ID, true)).resolves.toMatchObject({
      auth: "Bearer renewed-jwt",
    });
    raiseHandSpy.mockRestore();
  });
});

describe("completeSiwfLogin (deprecated)", () => {
  it("still exchanges a signed message for a body-token session", async () => {
    const requestBodies: unknown[] = [];
    stubFetch({
      "POST /v1/auth/siwf/login": (init) => {
        requestBodies.push(JSON.parse(String(init.body)));
        return {
          status: 200,
          body: { ...LOGIN_RESPONSE, refresh_token: "refresh-siwf" },
        };
      },
    });
    const sdk = createJukeEmbedSdk();

    const session = await sdk.completeSiwfLogin({
      message: "msg",
      signature: "0xsig",
    });

    expect(requestBodies).toEqual([
      { message: "msg", signature: "0xsig", use_cookie: false },
    ]);
    expect(session).toMatchObject({ source: "siwf", refreshToken: "refresh-siwf" });
  });
});
