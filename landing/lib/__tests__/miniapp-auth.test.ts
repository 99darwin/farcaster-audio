/**
 * Mini App Protocol Auth: token acquisition through the host wallet and the
 * `hqa1` -> Juke JWT exchange. The SDK is ESM-only, so it is mocked whole.
 */

const mockIsInMiniApp = jest.fn<Promise<boolean>, []>();
const mockGetEthereumProvider = jest.fn();
const mockGetToken = jest.fn();

jest.mock("@farcasterorg/miniapp-sdk", () => ({
  sdk: {
    isInMiniApp: () => mockIsInMiniApp(),
    wallet: { getEthereumProvider: () => mockGetEthereumProvider() },
    protocolAuth: {
      getToken: (options: unknown) => mockGetToken(options),
    },
  },
}));

import {
  authenticateMiniapp,
  clearCachedMiniappAuth,
  exchangeProtocolToken,
  getCachedMiniappAuth,
  MINIAPP_QUICKAUTH_PATH,
  MINIAPP_TOKEN_TTL_SECONDS,
  PROTOCOL_AUTH_TIMEOUT_MS,
  withProtocolAuthChainId,
} from "@/lib/miniapp-auth";
import { createFetchMock, TEST_BASE_URL, TEST_FID } from "@/lib/auth/__tests__/fixtures";

const PROTOCOL_TOKEN = "hqa1.bWVzc2FnZQ.c2lnbmF0dXJl";
const DEFAULT_API_BASE_URL = "http://localhost:8000";

function jwtExpiringIn(seconds: number): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + seconds;
  return `${encode({ alg: "HS256" })}.${encode({ sub: String(TEST_FID), exp })}.sig`;
}

type ProviderRequest = { method: string; params?: unknown };

function createHostProvider(chainIdHex = "0x2105") {
  const request = jest.fn(async ({ method }: ProviderRequest) => {
    if (method === "eth_chainId") return chainIdHex;
    if (method === "personal_sign") return "0xsigned";
    throw new Error(`unexpected ${method}`);
  });
  return { request, on: jest.fn(), removeListener: jest.fn() };
}

function mockFetchOnce(status: number, body: unknown, url = "") {
  const response = new Response(JSON.stringify(body), { status });
  Object.defineProperty(response, "url", { value: url });
  return jest.spyOn(global, "fetch").mockResolvedValueOnce(response);
}

beforeEach(() => {
  jest.restoreAllMocks();
  mockIsInMiniApp.mockReset();
  mockGetEthereumProvider.mockReset();
  mockGetToken.mockReset();
  clearCachedMiniappAuth();
});

describe("withProtocolAuthChainId", () => {
  it("reports Optimism and forwards every other request to the host", async () => {
    const host = createHostProvider("0x2105");
    const wrapped = withProtocolAuthChainId(host as never);

    await expect(wrapped.request({ method: "eth_chainId" } as never)).resolves.toBe(
      "0xa",
    );
    await expect(
      wrapped.request({ method: "personal_sign", params: ["0x00", "0x01"] } as never),
    ).resolves.toBe("0xsigned");
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(host.request).toHaveBeenCalledWith({
      method: "personal_sign",
      params: ["0x00", "0x01"],
    });

    const listener = jest.fn();
    wrapped.on?.("chainChanged" as never, listener as never);
    expect(host.on).toHaveBeenCalledWith("chainChanged", listener);
  });
});

describe("exchangeProtocolToken", () => {
  it("posts the token and returns the session JWT with its expiry", async () => {
    const jwt = jwtExpiringIn(3600);
    const { fetchImpl, requests } = createFetchMock({
      [`POST ${MINIAPP_QUICKAUTH_PATH}`]: () => ({
        status: 200,
        body: { token: jwt, fid: TEST_FID },
      }),
    });

    const result = await exchangeProtocolToken(PROTOCOL_TOKEN, {
      baseUrl: TEST_BASE_URL,
      fetchImpl,
    });

    expect(requests).toEqual([
      { method: "POST", path: MINIAPP_QUICKAUTH_PATH, body: { token: PROTOCOL_TOKEN } },
    ]);
    expect(result).toMatchObject({ ok: true, token: jwt, fid: TEST_FID });
    if (!result.ok) throw new Error("expected ok");
    expect(result.expiresAt).toBeGreaterThan(Date.now() + 3500 * 1000);
  });

  it.each([
    [401, "verify_failed"],
    [403, "verify_failed"],
    [502, "network"],
  ])("maps HTTP %i to %s", async (status, reason) => {
    const { fetchImpl } = createFetchMock({
      [`POST ${MINIAPP_QUICKAUTH_PATH}`]: () => ({
        status,
        body: { detail: "Invalid Quick Auth token" },
      }),
    });
    await expect(
      exchangeProtocolToken(PROTOCOL_TOKEN, { baseUrl: TEST_BASE_URL, fetchImpl }),
    ).resolves.toEqual({ ok: false, reason });
  });

  it.each([
    ["a missing token", { fid: TEST_FID }],
    ["a non-integer fid", { token: "jwt", fid: "4242" }],
    ["a non-positive fid", { token: "jwt", fid: 0 }],
  ])("rejects a response with %s", async (_label, body) => {
    const { fetchImpl } = createFetchMock({
      [`POST ${MINIAPP_QUICKAUTH_PATH}`]: () => ({ status: 200, body }),
    });
    await expect(
      exchangeProtocolToken(PROTOCOL_TOKEN, { baseUrl: TEST_BASE_URL, fetchImpl }),
    ).resolves.toEqual({ ok: false, reason: "invalid_response" });
  });

  it("rejects a response served from another origin", async () => {
    const fetchImpl = (async () => {
      const response = new Response(JSON.stringify({ token: "jwt", fid: TEST_FID }));
      Object.defineProperty(response, "url", {
        value: "https://evil.example/v1/auth/miniapp-quickauth",
      });
      return response;
    }) as typeof fetch;
    await expect(
      exchangeProtocolToken(PROTOCOL_TOKEN, { baseUrl: TEST_BASE_URL, fetchImpl }),
    ).resolves.toEqual({ ok: false, reason: "invalid_response" });
  });

  it("maps a thrown fetch to network", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("offline");
    }) as typeof fetch;
    await expect(
      exchangeProtocolToken(PROTOCOL_TOKEN, { baseUrl: TEST_BASE_URL, fetchImpl }),
    ).resolves.toEqual({ ok: false, reason: "network" });
  });
});

describe("authenticateMiniapp", () => {
  it("returns not_in_miniapp without touching the wallet outside a host", async () => {
    mockIsInMiniApp.mockResolvedValue(false);
    await expect(authenticateMiniapp()).resolves.toEqual({
      ok: false,
      reason: "not_in_miniapp",
    });
    expect(mockGetEthereumProvider).not.toHaveBeenCalled();
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  describe("inside a frame", () => {
    const globals = globalThis as { window?: unknown };
    afterEach(() => {
      delete globals.window;
    });

    function frameUnder(parentOrigin: string) {
      globals.window = {
        parent: {},
        location: { ancestorOrigins: [parentOrigin] },
        document: { referrer: "" },
      };
    }

    it("refuses a fake host on an arbitrary site without asking it to sign", async () => {
      frameUnder("https://attacker.example");
      mockIsInMiniApp.mockResolvedValue(true);
      await expect(authenticateMiniapp()).resolves.toEqual({
        ok: false,
        reason: "not_in_miniapp",
      });
      expect(mockIsInMiniApp).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
    });

    it("still signs in when framed by a Farcaster client", async () => {
      frameUnder("https://farcaster.xyz");
      mockIsInMiniApp.mockResolvedValue(true);
      mockGetEthereumProvider.mockResolvedValue(undefined);
      await authenticateMiniapp();
      expect(mockIsInMiniApp).toHaveBeenCalled();
      expect(mockGetEthereumProvider).toHaveBeenCalled();
    });
  });

  it("returns not_in_miniapp when the host has no wallet", async () => {
    mockIsInMiniApp.mockResolvedValue(true);
    mockGetEthereumProvider.mockResolvedValue(undefined);
    await expect(authenticateMiniapp()).resolves.toEqual({
      ok: false,
      reason: "not_in_miniapp",
    });
    expect(mockGetToken).not.toHaveBeenCalled();
  });

  it("signs with a chain-id-10 provider and exchanges the hqa1 token", async () => {
    const host = createHostProvider("0x2105");
    mockIsInMiniApp.mockResolvedValue(true);
    mockGetEthereumProvider.mockResolvedValue(host);
    mockGetToken.mockImplementation(
      async (options: { provider: { request: (args: ProviderRequest) => unknown } }) => {
        // The SDK reads the chain id into the SIWE message before signing.
        expect(await options.provider.request({ method: "eth_chainId" })).toBe("0xa");
        return { token: PROTOCOL_TOKEN };
      },
    );
    const jwt = jwtExpiringIn(3600);
    const fetchSpy = mockFetchOnce(
      200,
      { token: jwt, fid: TEST_FID },
      `${DEFAULT_API_BASE_URL}${MINIAPP_QUICKAUTH_PATH}`,
    );

    const result = await authenticateMiniapp();

    expect(result).toMatchObject({ ok: true, token: jwt, fid: TEST_FID });
    // No fid / no auth server: the SDK takes the FID from the host context.
    // The token lifetime is explicit (backend cap: 1h) and the SDK's cached
    // token is reused unless the caller forces a new one.
    expect(mockGetToken).toHaveBeenCalledWith({
      provider: expect.anything(),
      force: false,
      expiresIn: MINIAPP_TOKEN_TTL_SECONDS,
    });
    expect(MINIAPP_TOKEN_TTL_SECONDS).toBe(3600);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${DEFAULT_API_BASE_URL}${MINIAPP_QUICKAUTH_PATH}`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: PROTOCOL_TOKEN }),
      }),
    );
  });

  it("maps a wallet rejection to user_cancelled", async () => {
    mockIsInMiniApp.mockResolvedValue(true);
    mockGetEthereumProvider.mockResolvedValue(createHostProvider());
    mockGetToken.mockRejectedValue(
      Object.assign(new Error("User rejected the request."), { code: 4001 }),
    );
    const fetchSpy = jest.spyOn(global, "fetch");

    await expect(authenticateMiniapp()).resolves.toEqual({
      ok: false,
      reason: "user_cancelled",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("asks the host wallet for a new token when forced", async () => {
    mockIsInMiniApp.mockResolvedValue(true);
    mockGetEthereumProvider.mockResolvedValue(createHostProvider());
    mockGetToken.mockResolvedValue({ token: PROTOCOL_TOKEN });
    mockFetchOnce(200, { token: jwtExpiringIn(3600), fid: TEST_FID });

    await authenticateMiniapp({ force: true });

    expect(mockGetToken).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
    );
  });

  it("waits for a slow wallet approval instead of reporting no host", async () => {
    jest.useFakeTimers();
    try {
      mockIsInMiniApp.mockResolvedValue(true);
      mockGetEthereumProvider.mockResolvedValue(createHostProvider());
      let approve: (value: { token: string }) => void = () => {};
      mockGetToken.mockReturnValue(
        new Promise((resolve) => {
          approve = resolve;
        }),
      );
      mockFetchOnce(200, { token: jwtExpiringIn(3600), fid: TEST_FID });

      const pending = authenticateMiniapp();
      await jest.advanceTimersByTimeAsync(45_000);
      approve({ token: PROTOCOL_TOKEN });

      await expect(pending).resolves.toMatchObject({ ok: true, fid: TEST_FID });
    } finally {
      jest.useRealTimers();
    }
  });

  it("maps a wedged host bridge to timeout, not not_in_miniapp", async () => {
    jest.useFakeTimers();
    try {
      mockIsInMiniApp.mockResolvedValue(true);
      mockGetEthereumProvider.mockResolvedValue(createHostProvider());
      mockGetToken.mockReturnValue(new Promise(() => {}));

      const pending = authenticateMiniapp();
      await jest.advanceTimersByTimeAsync(PROTOCOL_AUTH_TIMEOUT_MS);

      await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    } finally {
      jest.useRealTimers();
    }
  });

  it("maps other signing failures to network", async () => {
    mockIsInMiniApp.mockResolvedValue(true);
    mockGetEthereumProvider.mockResolvedValue(createHostProvider());
    mockGetToken.mockRejectedValue(new Error("bridge closed"));
    await expect(authenticateMiniapp()).resolves.toEqual({
      ok: false,
      reason: "network",
    });
  });
});

describe("getCachedMiniappAuth", () => {
  function primeHost(jwt: string) {
    mockIsInMiniApp.mockResolvedValue(true);
    mockGetEthereumProvider.mockResolvedValue(createHostProvider());
    mockGetToken.mockResolvedValue({ token: PROTOCOL_TOKEN });
    return jest.spyOn(global, "fetch").mockImplementation(
      async () => new Response(JSON.stringify({ token: jwt, fid: TEST_FID })),
    );
  }

  it("reuses a session that is comfortably valid", async () => {
    const fetchSpy = primeHost(jwtExpiringIn(3600));
    await getCachedMiniappAuth();
    await getCachedMiniappAuth();
    expect(mockGetToken).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("signs again when the cached session is about to expire", async () => {
    primeHost(jwtExpiringIn(30));
    await getCachedMiniappAuth();
    await getCachedMiniappAuth();
    expect(mockGetToken).toHaveBeenCalledTimes(2);
  });

  it("signs again after the cache is cleared", async () => {
    primeHost(jwtExpiringIn(3600));
    await getCachedMiniappAuth();
    clearCachedMiniappAuth();
    await getCachedMiniappAuth();
    expect(mockGetToken).toHaveBeenCalledTimes(2);
  });
});
