/**
 * Sign-in / re-link flow against a mocked backend.
 *
 * Real modules: the reducer, signerLink (real viem signing with the public
 * Hardhat test phrase), deviceLogin, authAddress, storage and authStore.
 * Mocked: the HTTP layer, Farcaster lookup and SecureStore (in-memory, so
 * the test can assert on everything that was persisted).
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";
import { AxiosError, AxiosHeaders, type AxiosResponse } from "axios";
import { recoverTypedDataAddress } from "viem";
import {
  INITIAL_SIGNER_LINK_STATE,
  signerLinkReducer,
  useSignerLinkFlow,
  type SignerLinkState,
} from "@/hooks/useSignerLinkFlow";
import * as api from "@/services/api";
import {
  lookupFarcasterUser,
  type FarcasterUserSummary,
} from "@/services/farcasterLookup";
import { useAuthStore } from "@/stores/authStore";
import {
  makePrepare,
  OTHER_PHRASE,
  TEST_AUTH_ACCOUNT,
  TEST_CUSTODY,
  TEST_FID,
  TEST_PHRASE,
} from "@/services/__fixtures__/signerLink";
import type {
  LoginResponse,
  SignerPrepareRequest,
  SignerPrepareResponse,
  SignerRegisterRequest,
} from "@/types/api";

const mockSecureStore: Record<string, string> = {};

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(async (key: string) => mockSecureStore[key] ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureStore[key] = value;
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    delete mockSecureStore[key];
  }),
}));

jest.mock("@/utils/cryptoPolyfill", () => ({}));

jest.mock("@/services/api", () => {
  const axios = jest.requireActual("axios") as typeof import("axios");
  return {
    getSiwfNonce: jest.fn(),
    protocolLogin: jest.fn(),
    prepareSigner: jest.fn(),
    registerSigner: jest.fn(),
    getSignerStatus: jest.fn(),
    getApiErrorStatus: (error: unknown) =>
      axios.isAxiosError(error) ? (error.response?.status ?? null) : null,
    getApiErrorCode: (error: unknown) => {
      if (!axios.isAxiosError(error)) return null;
      const detail = (error.response?.data as { detail?: unknown } | undefined)
        ?.detail;
      if (typeof detail === "string") return detail;
      return (detail as { code?: string } | undefined)?.code ?? null;
    },
  };
});

jest.mock("@/services/farcasterLookup", () => ({
  ...(jest.requireActual("@/services/farcasterLookup") as object),
  lookupFarcasterUser: jest.fn(),
}));

const mockedApi = api as jest.Mocked<typeof api>;
const mockedLookup = lookupFarcasterUser as jest.MockedFunction<
  typeof lookupFarcasterUser
>;

const USER: FarcasterUserSummary = {
  fid: TEST_FID,
  username: "alice",
  displayName: "Alice",
  pfpUrl: null,
  custodyAddress: TEST_CUSTODY,
};

const LOGIN: LoginResponse = {
  jwt: "jwt-value",
  refresh_token: "refresh-value",
  expires_at: "2099-01-01T00:00:00Z",
  user: {
    fid: TEST_FID,
    username: "alice",
    display_name: "Alice",
    pfp_url: null,
    custody_address: TEST_CUSTODY,
    is_pro: false,
    is_admin: false,
    signer_status: "approved",
  },
};

function apiError(status: number, code: string): AxiosError {
  const response = {
    status,
    statusText: "",
    data: { detail: { code } },
    headers: {},
    config: { headers: new AxiosHeaders() },
  } as AxiosResponse;
  return new AxiosError(
    code,
    "ERR_BAD_REQUEST",
    undefined,
    undefined,
    response,
  );
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The backend builds payloads for whatever auth address the device sent. */
let lastPrepare: SignerPrepareResponse | null = null;
function installPrepare() {
  mockedApi.prepareSigner.mockImplementation(
    async (req: SignerPrepareRequest) => {
      lastPrepare = makePrepare(
        {},
        { authAddress: req.auth_address, nowSeconds: nowSeconds() },
      );
      return lastPrepare;
    },
  );
}

function seedLinkedDevice() {
  mockSecureStore[`auth_address_key_${TEST_FID}`] =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
}

async function renderAtConfirm(mode: "login" | "relink" = "login") {
  const hook = renderHook(() => useSignerLinkFlow({ mode, initialUser: USER }));
  expect(hook.result.current.state.step).toBe("confirm");
  return hook;
}

/** Every place the phrase could conceivably have leaked to. */
function everythingPersistedOrSent(hookState: SignerLinkState): string {
  const apiCalls = [
    mockedApi.getSiwfNonce,
    mockedApi.protocolLogin,
    mockedApi.prepareSigner,
    mockedApi.registerSigner,
    mockedApi.getSignerStatus,
  ].map((fn) => fn.mock.calls);
  const { user, jwt, refreshToken, expiresAt, isAuthenticated } =
    useAuthStore.getState();
  return JSON.stringify({
    secureStore: mockSecureStore,
    authStore: { user, jwt, refreshToken, expiresAt, isAuthenticated },
    apiCalls,
    hookState,
  });
}

function expectNoPhrase(serialized: string) {
  for (const phrase of [TEST_PHRASE, OTHER_PHRASE]) {
    expect(serialized).not.toContain(phrase);
    // Even a fragment of three consecutive words would be a leak.
    expect(serialized).not.toContain(phrase.split(" ").slice(0, 3).join(" "));
  }
  expect(serialized).not.toContain("junk");
}

beforeEach(async () => {
  for (const key of Object.keys(mockSecureStore)) delete mockSecureStore[key];
  jest.clearAllMocks();
  lastPrepare = null;
  await useAuthStore.getState().logout();
  mockedApi.getSiwfNonce.mockResolvedValue({ nonce: "abcdef12345678" });
  installPrepare();
});

describe("signerLinkReducer", () => {
  const prepare = makePrepare();

  it("ignores events that don't apply to the current step", () => {
    const confirm: SignerLinkState = {
      step: "confirm",
      user: USER,
      error: null,
    };
    expect(signerLinkReducer(confirm, { type: "PREPARED", prepare })).toBe(
      confirm,
    );
    expect(
      signerLinkReducer(INITIAL_SIGNER_LINK_STATE, { type: "COMPLETED" }),
    ).toBe(INITIAL_SIGNER_LINK_STATE);
    const done: SignerLinkState = { step: "done", user: USER };
    expect(signerLinkReducer(done, { type: "FAILED", error: "late" })).toBe(
      done,
    );
  });

  it("walks the phrase path and returns to the phrase step on rejection", () => {
    let state: SignerLinkState = { step: "confirm", user: USER, error: null };
    state = signerLinkReducer(state, { type: "PREPARE_STARTED" });
    expect(state.step).toBe("preparing");
    state = signerLinkReducer(state, { type: "PREPARED", prepare });
    expect(state.step).toBe("phrase");
    state = signerLinkReducer(state, { type: "REGISTER_STARTED", prepare });
    expect(state.step).toBe("registering");
    state = signerLinkReducer(state, {
      type: "PHRASE_REJECTED",
      error: "nope",
    });
    expect(state).toMatchObject({ step: "phrase", error: "nope" });
    state = signerLinkReducer(state, { type: "REGISTER_STARTED", prepare });
    state = signerLinkReducer(state, {
      type: "LINK_STATUS",
      prepareId: "prep_1",
      linkStatus: "submitted",
    });
    expect(state).toMatchObject({ step: "waiting", linkStatus: "submitted" });
    state = signerLinkReducer(state, { type: "COMPLETED" });
    expect(state.step).toBe("done");
  });
});

describe("useSignerLinkFlow", () => {
  it("looks up a user and moves to confirm", async () => {
    mockedLookup.mockResolvedValue(USER);
    const { result } = renderHook(() => useSignerLinkFlow({ mode: "login" }));
    await act(() => result.current.lookup("@alice"));
    expect(result.current.state).toEqual({
      step: "confirm",
      user: USER,
      error: null,
    });
  });

  it("signs in with an already-linked auth address without the phrase", async () => {
    seedLinkedDevice();
    mockedApi.protocolLogin.mockResolvedValue(LOGIN);
    const { result } = await renderAtConfirm();

    await act(() => result.current.start());

    expect(result.current.state.step).toBe("done");
    expect(mockedApi.prepareSigner).not.toHaveBeenCalled();
    const [{ token, use_cookie }] = mockedApi.protocolLogin.mock.calls[0];
    expect(token.startsWith("hqa1.")).toBe(true);
    expect(use_cookie).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(mockSecureStore.last_linked_fid).toBe(String(TEST_FID));
    expect(mockSecureStore[`auth_address_status_${TEST_FID}`]).toBe("approved");
  });

  it("falls back to the phrase link on 403 signer_not_linked", async () => {
    seedLinkedDevice();
    mockedApi.protocolLogin.mockRejectedValue(
      apiError(403, "signer_not_linked"),
    );
    const { result } = await renderAtConfirm();

    await act(() => result.current.start());

    expect(result.current.state.step).toBe("phrase");
    expect(mockedApi.prepareSigner).toHaveBeenCalledWith({
      fid: TEST_FID,
      auth_address: TEST_AUTH_ACCOUNT.address.toLowerCase(),
    });
    // A pre-existing key is re-written so it gets THIS_DEVICE_ONLY.
    const { setItemAsync } = jest.requireMock<{
      setItemAsync: jest.Mock;
    }>("expo-secure-store");
    expect(setItemAsync).toHaveBeenCalledWith(
      `auth_address_key_${TEST_FID}`,
      mockSecureStore[`auth_address_key_${TEST_FID}`],
      { keychainAccessible: "whenUnlockedThisDeviceOnly" },
    );
  });

  it("links a new device end to end and never keeps the phrase", async () => {
    mockedApi.registerSigner.mockResolvedValue({
      prepare_id: "prep_1",
      status: "pending",
    });
    mockedApi.getSignerStatus.mockResolvedValue({
      prepare_id: "prep_1",
      status: "approved",
      signer_tx_hash: "0x01",
      auth_address_tx_hash: "0x02",
      error: null,
    });
    mockedApi.protocolLogin.mockResolvedValue(LOGIN);
    const { result } = await renderAtConfirm();

    // No auth address on this device: straight to prepare, no login attempt.
    await act(() => result.current.start());
    expect(mockedApi.protocolLogin).not.toHaveBeenCalled();
    expect(result.current.state.step).toBe("phrase");

    // Wrong account's phrase: stays on the phrase step with an error.
    await act(() => result.current.submitPhrase(OTHER_PHRASE));
    expect(result.current.state).toMatchObject({ step: "phrase" });
    expect((result.current.state as { error: string | null }).error).toMatch(
      /recovery phrase/,
    );
    expect(mockedApi.registerSigner).not.toHaveBeenCalled();

    await act(() => result.current.submitPhrase(TEST_PHRASE));
    expect(result.current.state.step).toBe("done");

    const request = mockedApi.registerSigner.mock
      .calls[0][0] as SignerRegisterRequest;
    const prepare = lastPrepare as SignerPrepareResponse;
    const { EIP712Domain: _ignored, ...types } =
      prepare.typed_data.signer.types;
    await expect(
      recoverTypedDataAddress({
        domain: prepare.typed_data.signer.domain,
        types,
        primaryType: prepare.typed_data.signer.primaryType,
        message: prepare.typed_data.signer.message,
        signature: request.signer_add_signature,
      } as Parameters<typeof recoverTypedDataAddress>[0]),
    ).resolves.toBe(TEST_CUSTODY);
    expect(mockedApi.getSignerStatus).toHaveBeenCalledWith("prep_1");
    // The session comes from a device-signed protocol login, not the poll.
    const [{ token }] = mockedApi.protocolLogin.mock.calls[0];
    expect(token.startsWith("hqa1.")).toBe(true);

    expect(useAuthStore.getState().user?.signer_status).toBe("approved");
    expect(mockSecureStore[`auth_address_status_${TEST_FID}`]).toBe("approved");
    expectNoPhrase(everythingPersistedOrSent(result.current.state));
  });

  it("ignores a session in the status response and logs in with the device key", async () => {
    mockedApi.registerSigner.mockResolvedValue({
      prepare_id: "prep_1",
      status: "pending",
    });
    // A legacy (or tampered) server still putting a session in the poll.
    mockedApi.getSignerStatus.mockResolvedValue({
      prepare_id: "prep_1",
      status: "approved",
      signer_tx_hash: "0x01",
      auth_address_tx_hash: "0x02",
      error: null,
      login: { ...LOGIN, jwt: "status-poll-jwt" },
    } as Awaited<ReturnType<typeof api.getSignerStatus>>);
    mockedApi.protocolLogin.mockResolvedValue(LOGIN);
    const { result } = await renderAtConfirm();
    await act(() => result.current.start());
    await act(() => result.current.submitPhrase(TEST_PHRASE));

    expect(result.current.state.step).toBe("done");
    expect(mockedApi.protocolLogin).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().jwt).toBe(LOGIN.jwt);
  });

  it("retries the post-link login while the backend catches up", async () => {
    jest.useFakeTimers();
    try {
      mockedApi.registerSigner.mockResolvedValue({
        prepare_id: "prep_1",
        status: "approved",
      });
      mockedApi.getSignerStatus.mockResolvedValue({
        prepare_id: "prep_1",
        status: "approved",
        signer_tx_hash: "0x01",
        auth_address_tx_hash: "0x02",
        error: null,
      });
      mockedApi.protocolLogin
        .mockRejectedValueOnce(apiError(403, "signer_not_linked"))
        .mockResolvedValue(LOGIN);
      const { result } = await renderAtConfirm();
      await act(() => result.current.start());
      let submitted: Promise<void> = Promise.resolve();
      await act(async () => {
        submitted = result.current.submitPhrase(TEST_PHRASE);
        await jest.runAllTimersAsync();
      });
      await act(() => submitted);

      expect(result.current.state.step).toBe("done");
      expect(mockedApi.protocolLogin).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("relink mode skips device login and goes straight to prepare", async () => {
    seedLinkedDevice();
    const { result } = await renderAtConfirm("relink");
    await act(() => result.current.start());
    expect(mockedApi.protocolLogin).not.toHaveBeenCalled();
    expect(result.current.state.step).toBe("phrase");
  });

  it("logs in with the auth address when prepare says already_linked", async () => {
    seedLinkedDevice();
    mockedApi.prepareSigner.mockRejectedValue(apiError(409, "already_linked"));
    mockedApi.protocolLogin.mockResolvedValue(LOGIN);
    const { result } = await renderAtConfirm("relink");
    await act(() => result.current.start());
    expect(result.current.state.step).toBe("done");
    expect(mockSecureStore[`auth_address_status_${TEST_FID}`]).toBe("approved");
  });

  it("returns to confirm with a readable error when linking fails on-chain", async () => {
    mockedApi.registerSigner.mockResolvedValue({
      prepare_id: "prep_1",
      status: "pending",
    });
    mockedApi.getSignerStatus.mockResolvedValue({
      prepare_id: "prep_1",
      status: "failed",
      signer_tx_hash: null,
      auth_address_tx_hash: null,
      error: "tx_reverted",
    });
    const { result } = await renderAtConfirm();
    await act(() => result.current.start());
    await act(() => result.current.submitPhrase(TEST_PHRASE));
    expect(result.current.state).toMatchObject({ step: "confirm" });
    expect((result.current.state as { error: string }).error).toMatch(/failed/);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expectNoPhrase(everythingPersistedOrSent(result.current.state));
  });
});
