import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  DeviceLoginError,
  loginWithAuthAddressAfterLink,
  POST_LINK_LOGIN_ATTEMPTS,
} from "@/services/deviceLogin";
import * as api from "@/services/api";
import { getAuthAddressAccount } from "@/services/authAddress";
import { TEST_AUTH_ACCOUNT, TEST_FID } from "@/services/__fixtures__/signerLink";
import type { LoginResponse } from "@/types/api";

jest.mock("@/utils/cryptoPolyfill", () => ({}));
jest.mock("@/services/authAddress", () => ({
  getAuthAddressAccount: jest.fn(),
}));
jest.mock("@/services/api", () => ({
  getSiwfNonce: jest.fn(),
  protocolLogin: jest.fn(),
  getApiErrorStatus: (error: unknown) =>
    (error as { status?: number }).status ?? null,
  getApiErrorCode: (error: unknown) =>
    (error as { code?: string }).code ?? null,
}));

const mockedApi = api as jest.Mocked<typeof api>;
const mockedAccount = getAuthAddressAccount as jest.MockedFunction<
  typeof getAuthAddressAccount
>;

const LOGIN = { jwt: "jwt-value" } as LoginResponse;
const NOT_LINKED = { status: 403, code: "signer_not_linked" };

describe("loginWithAuthAddressAfterLink", () => {
  const sleep = jest.fn(async (_ms: number) => undefined);

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAccount.mockResolvedValue(TEST_AUTH_ACCOUNT);
    mockedApi.getSiwfNonce.mockResolvedValue({ nonce: "abcdef12345678" });
  });

  it("signs a fresh nonce for every attempt and retries signer_not_linked", async () => {
    mockedApi.protocolLogin
      .mockRejectedValueOnce(NOT_LINKED)
      .mockRejectedValueOnce(NOT_LINKED)
      .mockResolvedValue(LOGIN);

    await expect(
      loginWithAuthAddressAfterLink(TEST_FID, { delayMs: 7, sleep }),
    ).resolves.toBe(LOGIN);

    expect(mockedApi.getSiwfNonce).toHaveBeenCalledTimes(3);
    expect(mockedApi.protocolLogin).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7);
  });

  it("gives up after the attempt budget", async () => {
    mockedApi.protocolLogin.mockRejectedValue(NOT_LINKED);

    await expect(
      loginWithAuthAddressAfterLink(TEST_FID, { sleep }),
    ).rejects.toMatchObject({ code: "signer_not_linked" });
    expect(mockedApi.protocolLogin).toHaveBeenCalledTimes(
      POST_LINK_LOGIN_ATTEMPTS,
    );
    expect(sleep).toHaveBeenCalledTimes(POST_LINK_LOGIN_ATTEMPTS - 1);
  });

  it("does not retry other failures", async () => {
    const serverError = { status: 500 };
    mockedApi.protocolLogin.mockRejectedValue(serverError);
    await expect(
      loginWithAuthAddressAfterLink(TEST_FID, { sleep }),
    ).rejects.toBe(serverError);
    expect(mockedApi.protocolLogin).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails fast when the device has no auth address", async () => {
    mockedAccount.mockResolvedValue(null);
    await expect(
      loginWithAuthAddressAfterLink(TEST_FID, { sleep }),
    ).rejects.toBeInstanceOf(DeviceLoginError);
    expect(mockedApi.getSiwfNonce).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});
