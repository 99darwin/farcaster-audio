/**
 * The 401 interceptor must only refresh for requests that ride the session
 * JWT. Sign-in / signer-link / refresh endpoints answer 401 for reasons that
 * have nothing to do with the session (e.g. `invalid_token` on an hqa1 token).
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { AxiosError, type AxiosAdapter, type AxiosResponse } from "axios";

const mockRefreshSession = jest.fn<() => Promise<unknown>>();

jest.mock("@/services/authRefresh", () => ({
  refreshSession: () => mockRefreshSession(),
}));
jest.mock("@/services/storage", () => ({
  getTokens: async () => ({ jwt: "jwt", refreshToken: "refresh" }),
}));
jest.mock("@/stores/authStore", () => ({
  useAuthStore: { getState: () => ({ markSignerNotLinked: jest.fn() }) },
}));

import {
  apiClient,
  getSiwfNonce,
  getSignerStatus,
  isSessionlessAuthPath,
  protocolLogin,
} from "@/services/api";

const HTTP_UNAUTHORIZED = 401;

/** Every request fails with `401 invalid_token`. */
const unauthorizedAdapter: AxiosAdapter = async (config) => {
  const response = {
    status: HTTP_UNAUTHORIZED,
    statusText: "Unauthorized",
    data: { detail: { code: "invalid_token" } },
    headers: {},
    config,
  } as AxiosResponse;
  throw new AxiosError(
    "Unauthorized",
    AxiosError.ERR_BAD_REQUEST,
    config,
    null,
    response,
  );
};

describe("401 refresh interceptor", () => {
  beforeEach(() => {
    mockRefreshSession.mockReset();
    mockRefreshSession.mockResolvedValue(null);
    // The interceptor logs every failure under __DEV__; keep test output clean.
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    apiClient.defaults.adapter = unauthorizedAdapter;
  });

  it("does not refresh when /v1/auth/protocol rejects the token", async () => {
    await expect(
      protocolLogin({ token: "hqa1.a.b", use_cookie: false }),
    ).rejects.toMatchObject({ response: { status: HTTP_UNAUTHORIZED } });
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  it("does not refresh for the nonce or signer-link endpoints", async () => {
    await expect(getSiwfNonce()).rejects.toBeInstanceOf(AxiosError);
    await expect(getSignerStatus("prepare-id")).rejects.toBeInstanceOf(
      AxiosError,
    );
    expect(mockRefreshSession).not.toHaveBeenCalled();
  });

  it("still refreshes for session-authenticated requests", async () => {
    await expect(apiClient.get("/v1/rooms")).rejects.toBeInstanceOf(AxiosError);
    expect(mockRefreshSession).toHaveBeenCalledTimes(1);
  });
});

describe("isSessionlessAuthPath", () => {
  it.each([
    ["/v1/auth/protocol", true],
    ["/v1/auth/siwf/nonce", true],
    ["/v1/auth/refresh", true],
    ["/v1/auth/dev-login", true],
    ["/v1/auth/signer/prepare", true],
    ["/v1/auth/signer/status", true],
    ["/v1/auth/logout", false],
    ["/v1/rooms", false],
    [undefined, false],
  ])("%s -> %s", (url, expected) => {
    expect(isSessionlessAuthPath(url)).toBe(expected);
  });
});
