import type { LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { DirectCastAuthRequest } from "@/lib/api/messages.types";
import type { AuthAddressStore } from "@/lib/auth/authAddressStore";
import { MESSAGING_TOKEN_TTL_MS } from "@/lib/auth/messagingToken";
import { LinkRequiredError } from "@/lib/auth/protocolLogin";
import {
  linkBrowserWithRecoveryPhrase,
  signInReturningBrowser,
  type LinkProgress,
} from "@/lib/auth/webSignIn";
import {
  LOGIN_RESPONSE,
  TEST_BASE_URL,
  TEST_FID,
  TEST_MNEMONIC,
  buildPrepare,
  createFetchMock,
} from "./fixtures";

function createStore(account: LocalAccount | null): AuthAddressStore & {
  created: LocalAccount;
} {
  const created = account ?? privateKeyToAccount(generatePrivateKey());
  return {
    created,
    load: jest.fn(async () => account),
    loadOrCreate: jest.fn(async () => created),
    remove: jest.fn(async () => undefined),
  };
}

const NONCE_ROUTE = {
  "POST /v1/auth/siwf/nonce": () => ({ status: 200, body: { nonce: "n0nce123" } }),
};

describe("signInReturningBrowser", () => {
  it("asks for a link when this browser has no key", async () => {
    await expect(
      signInReturningBrowser({ fid: TEST_FID, store: createStore(null) }),
    ).rejects.toBeInstanceOf(LinkRequiredError);
  });
});

describe("linkBrowserWithRecoveryPhrase", () => {
  const nowSeconds = Math.floor(Date.now() / 1000);

  it("signs in without the phrase when the key is already linked", async () => {
    const store = createStore(null);
    const { fetchImpl, requests } = createFetchMock({
      ...NONCE_ROUTE,
      "POST /v1/auth/signer/prepare": () => ({
        status: 409,
        body: { detail: "already_linked" },
      }),
      "POST /v1/auth/protocol": () => ({ status: 200, body: LOGIN_RESPONSE }),
    });
    const takeRecoveryPhrase = jest.fn(() => TEST_MNEMONIC);

    const response = await linkBrowserWithRecoveryPhrase(
      { fid: TEST_FID, store, takeRecoveryPhrase },
      { baseUrl: TEST_BASE_URL, fetchImpl },
    );

    expect(response).toEqual(LOGIN_RESPONSE);
    // The field is still wiped, but nothing derived from it is sent.
    expect(takeRecoveryPhrase).toHaveBeenCalledTimes(1);
    expect(requests.map((r) => r.path)).not.toContain("/v1/auth/signer/register");
  });

  it("links, polls and signs in with a fresh protocol login", async () => {
    const store = createStore(null);
    const prepare = buildPrepare({ authAddress: store.created.address, nowSeconds });
    const { fetchImpl, requests } = createFetchMock({
      ...NONCE_ROUTE,
      "POST /v1/auth/signer/prepare": () => ({ status: 200, body: prepare }),
      "POST /v1/auth/signer/register": () => ({
        status: 202,
        body: { prepare_id: prepare.prepare_id, status: "pending" },
      }),
      "GET /v1/auth/signer/status": () => ({
        status: 200,
        body: {
          prepare_id: prepare.prepare_id,
          status: "approved",
          signer_tx_hash: "0x1",
          auth_address_tx_hash: "0x2",
          error: null,
        },
      }),
      "POST /v1/auth/protocol": () => ({ status: 200, body: LOGIN_RESPONSE }),
    });
    const progress: LinkProgress[] = [];

    const response = await linkBrowserWithRecoveryPhrase(
      {
        fid: TEST_FID,
        store,
        takeRecoveryPhrase: () => TEST_MNEMONIC,
        onProgress: (next) => progress.push(next),
      },
      { baseUrl: TEST_BASE_URL, fetchImpl },
    );

    expect(response).toEqual(LOGIN_RESPONSE);
    expect(progress).toEqual(["preparing", "signing", "submitting", "approved"]);

    const register = requests.find((r) => r.path === "/v1/auth/signer/register");
    expect(Object.keys(register?.body as object).sort()).toEqual([
      "auth_address_add_signature",
      "dc_auth_request",
      "dc_auth_signature",
      "prepare_id",
      "protocol_auth_token",
      "signer_add_signature",
    ]);
    const { dc_auth_request: dcRequest, dc_auth_signature: dcSignature } =
      register?.body as { dc_auth_request: DirectCastAuthRequest; dc_auth_signature: string };
    expect(dcRequest.method).toBe("generateToken");
    expect(dcRequest.params.expiresAt - dcRequest.params.timestamp).toBe(MESSAGING_TOKEN_TTL_MS);
    expect(dcSignature).toMatch(/^eip191:[A-Za-z0-9+/]+={0,2}$/);
    // Phrase hygiene: the phrase never appears in any request.
    const words = TEST_MNEMONIC.split(" ");
    for (const request of requests) {
      expect(JSON.stringify(request)).not.toContain(words.join(" "));
    }
  });

  function laggingNodeRoutes(
    prepareId: string,
    prepare: unknown,
    protocolStatuses: number[],
  ) {
    let protocolCalls = 0;
    return createFetchMock({
      ...NONCE_ROUTE,
      "POST /v1/auth/signer/prepare": () => ({ status: 200, body: prepare }),
      "POST /v1/auth/signer/register": () => ({
        status: 409,
        body: { detail: "already_submitted" },
      }),
      // A legacy (or tampered) server still putting a session in the poll.
      "GET /v1/auth/signer/status": () => ({
        status: 200,
        body: {
          prepare_id: prepareId,
          status: "approved",
          signer_tx_hash: null,
          auth_address_tx_hash: null,
          error: null,
          login: { ...LOGIN_RESPONSE, jwt: "status-poll-jwt", refresh_token: "leak" },
        },
      }),
      "POST /v1/auth/protocol": () => {
        const status =
          protocolStatuses[Math.min(protocolCalls, protocolStatuses.length - 1)] ?? 200;
        protocolCalls += 1;
        return status === 200
          ? { status, body: LOGIN_RESPONSE }
          : { status, body: { detail: "signer_not_linked" } };
      },
    });
  }

  async function runWithTimers<T>(promise: Promise<T>): Promise<T> {
    const settled = promise.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await jest.runAllTimersAsync();
    const result = await settled;
    if ("error" in result) throw result.error;
    return result.value;
  }

  it("retries the protocol login while the node lags and never uses a polled session", async () => {
    jest.useFakeTimers();
    try {
      const store = createStore(null);
      const prepare = buildPrepare({ authAddress: store.created.address, nowSeconds });
      const { fetchImpl, requests } = laggingNodeRoutes(
        prepare.prepare_id,
        prepare,
        [403, 403, 200],
      );

      const response = await runWithTimers(
        linkBrowserWithRecoveryPhrase(
          { fid: TEST_FID, store, takeRecoveryPhrase: () => TEST_MNEMONIC },
          { baseUrl: TEST_BASE_URL, fetchImpl },
        ),
      );

      expect(response).toEqual(LOGIN_RESPONSE);
      expect(requests.filter((r) => r.path === "/v1/auth/protocol")).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("asks to link again rather than falling back to a polled session", async () => {
    jest.useFakeTimers();
    try {
      const store = createStore(null);
      const prepare = buildPrepare({ authAddress: store.created.address, nowSeconds });
      const { fetchImpl } = laggingNodeRoutes(prepare.prepare_id, prepare, [403]);

      await expect(
        runWithTimers(
          linkBrowserWithRecoveryPhrase(
            { fid: TEST_FID, store, takeRecoveryPhrase: () => TEST_MNEMONIC },
            { baseUrl: TEST_BASE_URL, fetchImpl },
          ),
        ),
      ).rejects.toBeInstanceOf(LinkRequiredError);
    } finally {
      jest.useRealTimers();
    }
  });
});
