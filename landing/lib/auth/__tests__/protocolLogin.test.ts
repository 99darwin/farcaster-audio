import { recoverTypedDataAddress, verifyMessage } from "viem";
import {
  generatePrivateKey,
  mnemonicToAccount,
  privateKeyToAccount,
} from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";
import type {
  Eip712Payload,
  SignerPrepareResponse,
  SignerStatusResponse,
} from "@/lib/api/types";
import {
  AuthRequestError,
  CustodyMismatchError,
  FarcasterUserNotFoundError,
  InvalidRecoveryPhraseError,
  LinkRequiredError,
  SignerLinkFailedError,
  countRecoveryPhraseWords,
  extractErrorCode,
  latestAddDeadline,
  normalizeRecoveryPhrase,
  POST_LINK_LOGIN_ATTEMPTS,
  pollSignerLinkUntilApproved,
  prepareSignerLink,
  resolveFid,
  signInWithAuthAddress,
  signInWithAuthAddressAfterLink,
  UnexpectedSigningRequestError,
  signSignerLink,
  toAuthAddressKey,
  toSignableTypedData,
} from "@/lib/auth/protocolLogin";
import { decodeProtocolToken } from "@/lib/auth/protocolToken";
import {
  LOGIN_RESPONSE,
  OTHER_MNEMONIC,
  TEST_BASE_URL,
  TEST_FID,
  TEST_MNEMONIC,
  buildPrepare,
  createFetchMock,
} from "./fixtures";

const NOW = new Date("2026-10-16T10:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const LINK_TOKEN_TTL_SECONDS = 5 * 60;

describe("extractErrorCode", () => {
  it.each([
    [{ detail: "already_linked" }, "already_linked"],
    [{ detail: { code: "prepare_expired" } }, "prepare_expired"],
    [{ detail: { error: "invalid_token" } }, "invalid_token"],
    [{ code: "fid_not_found" }, "fid_not_found"],
    [{ error: "signer_not_linked" }, "signer_not_linked"],
    [{ detail: [{ msg: "validation" }] }, null],
    [undefined, null],
    ["text", null],
  ])("%j -> %s", (body, expected) => {
    expect(extractErrorCode(body)).toBe(expected);
  });
});

describe("recovery phrase helpers", () => {
  it("normalises whitespace and case", () => {
    expect(normalizeRecoveryPhrase("  Test\n test\ttest  ")).toBe("test test test");
  });

  it("counts words", () => {
    expect(countRecoveryPhraseWords("")).toBe(0);
    expect(countRecoveryPhraseWords("   ")).toBe(0);
    expect(countRecoveryPhraseWords(TEST_MNEMONIC)).toBe(12);
  });
});

describe("toSignableTypedData", () => {
  const authAddress = privateKeyToAccount(generatePrivateKey()).address;
  const prepare = buildPrepare({ authAddress, nowSeconds: NOW_SECONDS });

  it("drops EIP712Domain and coerces integer fields to bigint", () => {
    const typed = toSignableTypedData(prepare.typed_data.auth_address);
    expect(typed.types.EIP712Domain).toBeUndefined();
    expect(typed.message.nonce).toBe(BigInt(8));
    expect(typed.message.keyType).toBe(BigInt(2));
    expect(typed.message.deadline).toBe(BigInt(NOW_SECONDS + 600));
    expect(typed.message.key).toBe(toAuthAddressKey(authAddress));
    expect(typed.domain.chainId).toBe(10);
  });

  it("rejects a payload without its primary type", () => {
    expect(() =>
      toSignableTypedData({ ...prepare.typed_data.signer, primaryType: "Remove" }),
    ).toThrow();
  });

  it("rejects non-integer values for integer fields", () => {
    const payload = prepare.typed_data.signer;
    expect(() =>
      toSignableTypedData({ ...payload, message: { ...payload.message, nonce: "1.5" } }),
    ).toThrow();
  });
});

describe("signSignerLink", () => {
  const authAddress = privateKeyToAccount(generatePrivateKey()).address;
  const custody = mnemonicToAccount(TEST_MNEMONIC);

  it("signs both Add payloads and a token with the custody key", async () => {
    const prepare = buildPrepare({ authAddress, nowSeconds: NOW_SECONDS });
    const signed = await signSignerLink({
      fid: TEST_FID,
      authAddress,
      recoveryPhrase: `  ${TEST_MNEMONIC.toUpperCase()}  `,
      prepare,
      now: NOW,
    });

    for (const [payload, signature] of [
      [prepare.typed_data.signer, signed.signerAddSignature],
      [prepare.typed_data.auth_address, signed.authAddressAddSignature],
    ] as const) {
      const typed = toSignableTypedData(payload);
      const recovered = await recoverTypedDataAddress({
        ...(typed as Parameters<typeof recoverTypedDataAddress>[0]),
        signature,
      });
      expect(recovered).toBe(custody.address);
    }

    const { message, signature } = decodeProtocolToken(signed.protocolAuthToken);
    expect(
      await verifyMessage({ address: custody.address, message, signature }),
    ).toBe(true);
    const parsed = parseSiweMessage(message);
    expect(parsed.nonce).toBe(prepare.protocol_auth.nonce);
    expect(parsed.resources).toEqual([`farcaster://fid/${TEST_FID}`]);
    // Login TTL (5 min), not the full hour: the token only has to survive
    // the immediate register call (L5).
    expect(parsed.expirationTime?.getTime()).toBe(
      (NOW_SECONDS + LINK_TOKEN_TTL_SECONDS) * 1000,
    );
  });

  it("still bounds the token by a prepare that expires sooner", async () => {
    const prepare = buildPrepare({ authAddress, nowSeconds: NOW_SECONDS });
    const soon = NOW_SECONDS + 120;
    const signed = await signSignerLink({
      fid: TEST_FID,
      authAddress,
      recoveryPhrase: TEST_MNEMONIC,
      prepare: { ...prepare, protocol_auth: { ...prepare.protocol_auth, expires_at: soon } },
      now: NOW,
    });
    const { message } = decodeProtocolToken(signed.protocolAuthToken);
    expect(parseSiweMessage(message).expirationTime?.getTime()).toBe(soon * 1000);
  });

  it("refuses a phrase that is not the custody phrase", async () => {
    const prepare = buildPrepare({ authAddress, nowSeconds: NOW_SECONDS });
    await expect(
      signSignerLink({
        fid: TEST_FID,
        authAddress,
        recoveryPhrase: OTHER_MNEMONIC,
        prepare,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(CustodyMismatchError);
  });

  it("refuses an invalid mnemonic", async () => {
    const prepare = buildPrepare({ authAddress, nowSeconds: NOW_SECONDS });
    await expect(
      signSignerLink({
        fid: TEST_FID,
        authAddress,
        recoveryPhrase: "not a real phrase at all",
        prepare,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(InvalidRecoveryPhraseError);
  });

  describe("refuses a substituted payload before signing", () => {
    type PayloadEdit = (payload: Eip712Payload) => Eip712Payload;
    const withMessage =
      (fields: Record<string, unknown>): PayloadEdit =>
      (payload) => ({ ...payload, message: { ...payload.message, ...fields } });
    const withDomain =
      (fields: Record<string, unknown>): PayloadEdit =>
      (payload) => ({ ...payload, domain: { ...payload.domain, ...fields } });

    const ID_REGISTRY = "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b";
    const ATTACKER = "0x000000000000000000000000000000000000dEaD";
    const TRANSFER_TYPES = {
      Transfer: [
        { name: "fid", type: "uint256" },
        { name: "to", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    };

    async function expectRefused(
      prepare: SignerPrepareResponse,
      reason: RegExp,
    ): Promise<void> {
      const error = await signSignerLink({
        fid: TEST_FID,
        authAddress,
        recoveryPhrase: TEST_MNEMONIC,
        prepare,
        now: NOW,
      }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(UnexpectedSigningRequestError);
      expect((error as Error).message).toMatch(reason);
    }

    it.each<[string, "signer" | "auth_address", PayloadEdit, RegExp]>([
      [
        "an IdRegistry Transfer",
        "signer",
        () => ({
          domain: {
            name: "Farcaster IdRegistry",
            version: "1",
            chainId: 10,
            verifyingContract: ID_REGISTRY,
          },
          types: TRANSFER_TYPES,
          primaryType: "Transfer",
          message: { fid: TEST_FID, to: ATTACKER, nonce: 0, deadline: NOW_SECONDS },
        }),
        /domain/,
      ],
      ["another domain name", "signer", withDomain({ name: "Farcaster KeyRegistry" }), /domain/],
      ["another chain", "auth_address", withDomain({ chainId: 1 }), /domain/],
      [
        "another verifying contract",
        "signer",
        withDomain({ verifyingContract: ID_REGISTRY }),
        /domain/,
      ],
      ["an extra domain field", "signer", withDomain({ salt: `0x${"00".repeat(32)}` }), /domain/],
      [
        "a Transfer primary type on the KeyGateway domain",
        "signer",
        (payload) => ({
          ...payload,
          types: TRANSFER_TYPES,
          primaryType: "Transfer",
          message: { fid: TEST_FID, to: ATTACKER, nonce: 0, deadline: NOW_SECONDS },
        }),
        /message type/,
      ],
      [
        "a reordered Add type",
        "signer",
        (payload) => ({
          ...payload,
          types: { Add: [...(payload.types.Add ?? [])].reverse() },
        }),
        /message type/,
      ],
      ["another owner", "signer", withMessage({ owner: ATTACKER }), /owner/],
      ["a swapped key type", "signer", withMessage({ keyType: 2 }), /key type/],
      ["an auth address key type 1", "auth_address", withMessage({ keyType: 1 }), /key type/],
      [
        "another auth address",
        "auth_address",
        withMessage({ key: `0x${"0".repeat(24)}${ATTACKER.slice(2)}` }),
        /\(key\)/,
      ],
      [
        "an unpadded auth address",
        "auth_address",
        withMessage({ key: authAddress }),
        /\(key\)/,
      ],
      ["another signer key", "signer", withMessage({ key: `0x${"cd".repeat(32)}` }), /\(key\)/],
      ["another metadata type", "signer", withMessage({ metadataType: 0 }), /metadata type/],
      [
        "a far-future deadline",
        "auth_address",
        withMessage({ deadline: NOW_SECONDS + 7 * 24 * 60 * 60 }),
        /deadline/,
      ],
    ])("%s", async (_label, which, edit, reason) => {
      const prepare = buildPrepare({ authAddress, nowSeconds: NOW_SECONDS });
      const tampered: SignerPrepareResponse = {
        ...prepare,
        typed_data: { ...prepare.typed_data, [which]: edit(prepare.typed_data[which]) },
      };
      await expectRefused(tampered, reason);
    });

    it.each(["signer", "auth_address"] as const)(
      "a %s deadline that outlives the prepare",
      async (which) => {
        const prepare = buildPrepare({ authAddress, nowSeconds: NOW_SECONDS });
        // Inside the 1 h horizon, but one second past the prepare's expiry.
        const tampered: SignerPrepareResponse = {
          ...prepare,
          typed_data: {
            ...prepare.typed_data,
            [which]: withMessage({ deadline: prepare.expires_at + 1 })(
              prepare.typed_data[which],
            ),
          },
        };
        await expectRefused(tampered, /deadline/);
      },
    );

    it("a malformed signer public key", async () => {
      const prepare = buildPrepare({ authAddress, nowSeconds: NOW_SECONDS });
      await expectRefused({ ...prepare, signer_public_key: ATTACKER }, /signer key/);
    });

    it.each([
      ["domain", { domain: "other-rp.example", uri: "https://juke.audio" }],
      ["uri", { domain: "juke.audio", uri: "https://other-rp.example" }],
    ])("a substituted protocol auth %s", async (_label, override) => {
      const prepare = buildPrepare({ authAddress, nowSeconds: NOW_SECONDS });
      await expectRefused(
        { ...prepare, protocol_auth: { ...prepare.protocol_auth, ...override } },
        /sign-in domain/,
      );
    });
  });
});

describe("latestAddDeadline", () => {
  const HORIZON_SECONDS = 60 * 60 + 5 * 60;

  it("is bounded by the prepare expiry when it is sooner", () => {
    const expiresAt = NOW_SECONDS + 600;
    expect(latestAddDeadline({ expires_at: expiresAt }, NOW)).toBe(expiresAt);
  });

  it("is bounded by the 1 h horizon plus skew when the prepare is longer", () => {
    const expiresAt = NOW_SECONDS + 24 * 60 * 60;
    expect(latestAddDeadline({ expires_at: expiresAt }, NOW)).toBe(
      NOW_SECONDS + HORIZON_SECONDS,
    );
  });
});

describe("prepareSignerLink", () => {
  it("surfaces the contract error code", async () => {
    const { fetchImpl } = createFetchMock({
      "POST /v1/auth/signer/prepare": () => ({
        status: 409,
        body: { detail: { code: "already_linked" } },
      }),
    });
    const error = await prepareSignerLink(
      { fid: TEST_FID, authAddress: "0xAbCdEf0000000000000000000000000000000001" },
      { baseUrl: TEST_BASE_URL, fetchImpl },
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AuthRequestError);
    expect((error as AuthRequestError).code).toBe("already_linked");
    expect((error as AuthRequestError).status).toBe(409);
  });

  it("sends a lower-cased auth address", async () => {
    const { fetchImpl, requests } = createFetchMock({
      "POST /v1/auth/signer/prepare": () => ({ status: 200, body: {} }),
    });
    await prepareSignerLink(
      { fid: TEST_FID, authAddress: "0xAbCdEf0000000000000000000000000000000001" },
      { baseUrl: TEST_BASE_URL, fetchImpl },
    );
    expect(requests[0]?.body).toEqual({
      fid: TEST_FID,
      auth_address: "0xabcdef0000000000000000000000000000000001",
    });
  });
});

describe("signInWithAuthAddress", () => {
  const account = privateKeyToAccount(generatePrivateKey());

  it("requires a stored account", async () => {
    await expect(
      signInWithAuthAddress({ fid: TEST_FID, account: null }),
    ).rejects.toBeInstanceOf(LinkRequiredError);
  });

  it("exchanges a signed token for a cookie-backed session", async () => {
    const { fetchImpl, requests } = createFetchMock({
      "POST /v1/auth/siwf/nonce": () => ({ status: 200, body: { nonce: "n0nce123" } }),
      "POST /v1/auth/protocol": () => ({ status: 200, body: LOGIN_RESPONSE }),
    });
    const response = await signInWithAuthAddress(
      { fid: TEST_FID, account },
      { baseUrl: TEST_BASE_URL, fetchImpl },
    );
    expect(response).toEqual(LOGIN_RESPONSE);

    const body = requests[1]?.body as { token: string; use_cookie: boolean };
    expect(body.use_cookie).toBe(true);
    const { message, signature } = decodeProtocolToken(body.token);
    expect(await verifyMessage({ address: account.address, message, signature })).toBe(
      true,
    );
    expect(parseSiweMessage(message).nonce).toBe("n0nce123");
  });

  it("asks for a body refresh token when useCookie is false", async () => {
    const { fetchImpl, requests } = createFetchMock({
      "POST /v1/auth/siwf/nonce": () => ({ status: 200, body: { nonce: "n0nce123" } }),
      "POST /v1/auth/protocol": () => ({
        status: 200,
        body: { ...LOGIN_RESPONSE, refresh_token: "refresh-in-body" },
      }),
    });
    const response = await signInWithAuthAddress(
      { fid: TEST_FID, account },
      { baseUrl: TEST_BASE_URL, fetchImpl, useCookie: false },
    );
    expect(response.refresh_token).toBe("refresh-in-body");
    const body = requests[1]?.body as { use_cookie: boolean };
    expect(body.use_cookie).toBe(false);
  });

  it("maps 403 signer_not_linked to LinkRequiredError", async () => {
    const { fetchImpl } = createFetchMock({
      "POST /v1/auth/siwf/nonce": () => ({ status: 200, body: { nonce: "n0nce123" } }),
      "POST /v1/auth/protocol": () => ({
        status: 403,
        body: { detail: "signer_not_linked" },
      }),
    });
    await expect(
      signInWithAuthAddress(
        { fid: TEST_FID, account },
        { baseUrl: TEST_BASE_URL, fetchImpl },
      ),
    ).rejects.toBeInstanceOf(LinkRequiredError);
  });

  it("passes other failures through", async () => {
    const { fetchImpl } = createFetchMock({
      "POST /v1/auth/siwf/nonce": () => ({ status: 200, body: { nonce: "n0nce123" } }),
      "POST /v1/auth/protocol": () => ({
        status: 401,
        body: { detail: "invalid_token" },
      }),
    });
    await expect(
      signInWithAuthAddress(
        { fid: TEST_FID, account },
        { baseUrl: TEST_BASE_URL, fetchImpl },
      ),
    ).rejects.toBeInstanceOf(AuthRequestError);
  });

  it("does not treat an unrelated 403 as a missing link", async () => {
    const { fetchImpl } = createFetchMock({
      "POST /v1/auth/siwf/nonce": () => ({ status: 200, body: { nonce: "n0nce123" } }),
      "POST /v1/auth/protocol": () => ({ status: 403, body: { detail: "forbidden" } }),
    });
    const error = await signInWithAuthAddress(
      { fid: TEST_FID, account },
      { baseUrl: TEST_BASE_URL, fetchImpl },
    ).catch((err: unknown) => err);
    expect(error).not.toBeInstanceOf(LinkRequiredError);
    expect(error).toBeInstanceOf(AuthRequestError);
    expect((error as AuthRequestError).status).toBe(403);
  });
});

describe("signInWithAuthAddressAfterLink", () => {
  const account = privateKeyToAccount(generatePrivateKey());

  function protocolSequence(statuses: number[]) {
    let index = 0;
    return createFetchMock({
      "POST /v1/auth/siwf/nonce": () => ({ status: 200, body: { nonce: "n0nce123" } }),
      "POST /v1/auth/protocol": () => {
        const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
        index += 1;
        return status === 200
          ? { status, body: LOGIN_RESPONSE }
          : { status, body: { detail: status === 403 ? "signer_not_linked" : "boom" } };
      },
    });
  }

  it("retries signer_not_linked with a fresh nonce each time", async () => {
    const { fetchImpl, requests } = protocolSequence([403, 403, 200]);
    const sleep = jest.fn(async () => undefined);
    const response = await signInWithAuthAddressAfterLink(
      { fid: TEST_FID, account },
      { baseUrl: TEST_BASE_URL, fetchImpl, sleep, delayMs: 7 },
    );
    expect(response).toEqual(LOGIN_RESPONSE);
    expect(requests.filter((r) => r.path === "/v1/auth/siwf/nonce")).toHaveLength(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(7, undefined);
  });

  it("gives up after the attempt budget", async () => {
    const { fetchImpl, requests } = protocolSequence([403]);
    const sleep = jest.fn(async () => undefined);
    await expect(
      signInWithAuthAddressAfterLink(
        { fid: TEST_FID, account },
        { baseUrl: TEST_BASE_URL, fetchImpl, sleep },
      ),
    ).rejects.toBeInstanceOf(LinkRequiredError);
    expect(requests.filter((r) => r.path === "/v1/auth/protocol")).toHaveLength(
      POST_LINK_LOGIN_ATTEMPTS,
    );
  });

  it("does not retry other failures", async () => {
    const { fetchImpl, requests } = protocolSequence([500]);
    const sleep = jest.fn(async () => undefined);
    await expect(
      signInWithAuthAddressAfterLink(
        { fid: TEST_FID, account },
        { baseUrl: TEST_BASE_URL, fetchImpl, sleep },
      ),
    ).rejects.toBeInstanceOf(AuthRequestError);
    expect(requests.filter((r) => r.path === "/v1/auth/protocol")).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("stops when aborted", async () => {
    const { fetchImpl } = protocolSequence([403]);
    const controller = new AbortController();
    const sleep = jest.fn(async () => controller.abort());
    await expect(
      signInWithAuthAddressAfterLink(
        { fid: TEST_FID, account },
        { baseUrl: TEST_BASE_URL, fetchImpl, sleep, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe("pollSignerLinkUntilApproved", () => {
  function statusSequence(statuses: Array<Partial<SignerStatusResponse>>) {
    let index = 0;
    return createFetchMock({
      "GET /v1/auth/signer/status": () => {
        const next = statuses[Math.min(index, statuses.length - 1)];
        index += 1;
        return {
          status: 200,
          body: {
            prepare_id: "prep_123",
            status: "pending",
            signer_tx_hash: null,
            auth_address_tx_hash: null,
            error: null,
            ...next,
          },
        };
      },
    });
  }

  it("resolves once approved and reports each status", async () => {
    const { fetchImpl, requests } = statusSequence([
      { status: "pending" },
      { status: "submitted" },
      { status: "approved" },
    ]);
    const seen: string[] = [];
    const sleep = jest.fn(async () => undefined);
    const result = await pollSignerLinkUntilApproved("prep_123", {
      baseUrl: TEST_BASE_URL,
      fetchImpl,
      sleep,
      onStatus: (status) => seen.push(status),
    });
    expect(result.status).toBe("approved");
    expect(seen).toEqual(["pending", "submitted", "approved"]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3_000, undefined);
    expect(requests[0]?.path).toBe("/v1/auth/signer/status?prepare_id=prep_123");
  });

  it("throws with the backend error when the link fails", async () => {
    const { fetchImpl } = statusSequence([{ status: "failed", error: "tx_reverted" }]);
    const error = await pollSignerLinkUntilApproved("prep_123", {
      baseUrl: TEST_BASE_URL,
      fetchImpl,
      sleep: async () => undefined,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SignerLinkFailedError);
    expect((error as SignerLinkFailedError).code).toBe("tx_reverted");
  });

  it("times out after the contract window", async () => {
    const { fetchImpl, requests } = statusSequence([{ status: "pending" }]);
    let clock = 0;
    const error = await pollSignerLinkUntilApproved("prep_123", {
      baseUrl: TEST_BASE_URL,
      fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SignerLinkFailedError);
    expect((error as SignerLinkFailedError).code).toBe("timeout");
    // 3 min / 3 s → 60 sleeps, 61 polls.
    expect(requests).toHaveLength(61);
  });

  it("stops when aborted", async () => {
    const { fetchImpl } = statusSequence([{ status: "pending" }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      pollSignerLinkUntilApproved("prep_123", {
        baseUrl: TEST_BASE_URL,
        fetchImpl,
        signal: controller.signal,
      }),
    ).rejects.toThrow("Aborted");
  });
});

describe("resolveFid", () => {
  const HYPERSNAP = "https://node.test";

  it("accepts numeric FIDs without a lookup", async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    expect(await resolveFid(" 123 ", { fetchImpl })).toBe(123);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("looks up usernames on the Hypersnap node", async () => {
    const { fetchImpl, requests } = createFetchMock({
      "GET /v2/farcaster/user/by-username": () => ({
        status: 200,
        body: { user: { fid: 3 } },
      }),
    });
    expect(await resolveFid("@Dwr.eth", { hypersnapUrl: HYPERSNAP, fetchImpl })).toBe(3);
    expect(requests[0]?.path).toBe("/v2/farcaster/user/by-username?username=dwr.eth");
  });

  it("maps 404 and bad input to FarcasterUserNotFoundError", async () => {
    const { fetchImpl } = createFetchMock({
      "GET /v2/farcaster/user/by-username": () => ({
        status: 404,
        body: { message: "User not found" },
      }),
    });
    await expect(
      resolveFid("nobody", { hypersnapUrl: HYPERSNAP, fetchImpl }),
    ).rejects.toBeInstanceOf(FarcasterUserNotFoundError);
    await expect(resolveFid("  ", { fetchImpl })).rejects.toBeInstanceOf(
      FarcasterUserNotFoundError,
    );
    await expect(resolveFid("bad name!", { fetchImpl })).rejects.toBeInstanceOf(
      FarcasterUserNotFoundError,
    );
    await expect(resolveFid("0", { fetchImpl })).rejects.toBeInstanceOf(
      FarcasterUserNotFoundError,
    );
  });

  it("surfaces node failures", async () => {
    const { fetchImpl } = createFetchMock({
      "GET /v2/farcaster/user/by-username": () => ({ status: 502 }),
    });
    await expect(
      resolveFid("alice", { hypersnapUrl: HYPERSNAP, fetchImpl }),
    ).rejects.toBeInstanceOf(AuthRequestError);
  });
});
