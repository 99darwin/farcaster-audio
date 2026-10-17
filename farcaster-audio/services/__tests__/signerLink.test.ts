import { describe, expect, it, jest } from "@jest/globals";
import { recoverMessageAddress, recoverTypedDataAddress } from "viem";
import {
  assertKeyGatewayAdd,
  latestAddDeadline,
  normalizeRecoveryPhrase,
  pollSignerStatus,
  signMessagingToken,
  signSignerLink,
  SignerLinkError,
} from "@/services/signerLink";
import { canonicalizeAuthRequest } from "@/services/messagingToken";
import {
  decodeEip191,
  decodeHqa1,
  FIXED_NOW,
  FIXTURE_PREPARE_TTL_SECONDS,
  makeAddPayload,
  makePrepare,
  OTHER_PHRASE,
  TEST_AUTH_ACCOUNT,
  TEST_CUSTODY,
  TEST_FID,
  TEST_PHRASE,
  TEST_SIGNER_PUBLIC_KEY,
} from "@/services/__fixtures__/signerLink";
import type { Eip712Payload, SignerStatusResponse } from "@/types/api";
import { mnemonicToAccount } from "viem/accounts";

// The real polyfill pulls RN globals; Node already has WebCrypto.
jest.mock("@/utils/cryptoPolyfill", () => ({}));
// Pass-through spy so tests can prove the custody key was never derived.
jest.mock("viem/accounts", () => {
  const actual =
    jest.requireActual<typeof import("viem/accounts")>("viem/accounts");
  return { ...actual, mnemonicToAccount: jest.fn(actual.mnemonicToAccount) };
});

function typedDataArgs(payload: Eip712Payload) {
  const { EIP712Domain: _ignored, ...types } = payload.types;
  return {
    domain: payload.domain,
    types,
    primaryType: payload.primaryType,
    message: payload.message,
  };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(SignerLinkError);
  await expect(promise).rejects.toMatchObject({ code });
}

describe("normalizeRecoveryPhrase", () => {
  it("lowercases and collapses whitespace", () => {
    expect(
      normalizeRecoveryPhrase(
        `  ${TEST_PHRASE.toUpperCase().replace(/ /g, "  \n")} `,
      ),
    ).toBe(TEST_PHRASE);
  });

  it("rejects wrong word counts and non-wordlist words without echoing input", () => {
    const short = "test test test";
    expect(() => normalizeRecoveryPhrase(short)).toThrow(SignerLinkError);
    const typo = TEST_PHRASE.replace("junk", "junkk");
    try {
      normalizeRecoveryPhrase(typo);
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toMatchObject({ code: "phrase_invalid" });
      expect(String((error as Error).message)).not.toContain("junkk");
      expect(String((error as Error).message)).not.toContain("test test");
    }
  });
});

const FIXED_NOW_SECONDS = Math.floor(FIXED_NOW.getTime() / 1000);
const ONE_HOUR_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;
const LOGIN_TTL_SECONDS = 5 * 60;

function withMessage(
  p: Eip712Payload,
  fields: Record<string, unknown>,
): Eip712Payload {
  return { ...p, message: { ...p.message, ...fields } };
}

function withAddFields(
  p: Eip712Payload,
  edit: (fields: { name: string; type: string }[]) => { name: string; type: string }[],
): Eip712Payload {
  return { ...p, types: { ...p.types, Add: edit([...(p.types.Add ?? [])]) } };
}

describe("latestAddDeadline", () => {
  it("is the prepare expiry when that is sooner", () => {
    expect(latestAddDeadline(makePrepare(), FIXED_NOW)).toBe(
      FIXED_NOW_SECONDS + FIXTURE_PREPARE_TTL_SECONDS,
    );
  });

  it("never exceeds now + 1h + skew, whatever the prepare claims", () => {
    const prepare = makePrepare({ expires_at: FIXED_NOW_SECONDS + 365 * 86400 });
    expect(latestAddDeadline(prepare, FIXED_NOW)).toBe(
      FIXED_NOW_SECONDS + ONE_HOUR_SECONDS + CLOCK_SKEW_SECONDS,
    );
  });
});

describe("assertKeyGatewayAdd", () => {
  const expected = {
    owner: TEST_CUSTODY,
    keyType: 1,
    keys: [TEST_SIGNER_PUBLIC_KEY],
    latestDeadline: FIXED_NOW_SECONDS + FIXTURE_PREPARE_TTL_SECONDS,
  };

  it("accepts a payload without the optional EIP712Domain struct", () => {
    const payload = makeAddPayload(1, TEST_SIGNER_PUBLIC_KEY);
    const { EIP712Domain: _ignored, ...types } = payload.types;
    expect(() =>
      assertKeyGatewayAdd({ ...payload, types }, expected),
    ).not.toThrow();
  });

  it("accepts a genuine KeyGateway Add", () => {
    expect(() =>
      assertKeyGatewayAdd(makeAddPayload(1, TEST_SIGNER_PUBLIC_KEY), expected),
    ).not.toThrow();
  });

  it.each<[string, (p: Eip712Payload) => Eip712Payload]>([
    ["primary type", (p) => ({ ...p, primaryType: "Transfer" })],
    [
      "domain name",
      (p) => ({ ...p, domain: { ...p.domain, name: "Farcaster IdRegistry" } }),
    ],
    ["chain", (p) => ({ ...p, domain: { ...p.domain, chainId: 1 } })],
    [
      "contract",
      (p) => ({
        ...p,
        domain: { ...p.domain, verifyingContract: `0x${"11".repeat(20)}` },
      }),
    ],
    [
      "owner",
      (p) => ({
        ...p,
        message: { ...p.message, owner: `0x${"22".repeat(20)}` },
      }),
    ],
    ["key type", (p) => ({ ...p, message: { ...p.message, keyType: 2 } })],
    [
      "key",
      (p) => ({ ...p, message: { ...p.message, key: `0x${"cd".repeat(32)}` } }),
    ],
    ["domain version", (p) => ({ ...p, domain: { ...p.domain, version: "2" } })],
    [
      "domain with an extra salt field",
      (p) => ({ ...p, domain: { ...p.domain, salt: `0x${"00".repeat(32)}` } }),
    ],
    [
      "domain missing its version",
      (p) => {
        const { version: _v, ...domain } = p.domain;
        return { ...p, domain };
      },
    ],
    ["string chain id", (p) => ({ ...p, domain: { ...p.domain, chainId: "10" } })],
    [
      "extra struct in types",
      (p) => ({
        ...p,
        types: { ...p.types, Transfer: [{ name: "to", type: "address" }] },
      }),
    ],
    [
      "non-canonical EIP712Domain struct",
      (p) => ({
        ...p,
        types: {
          ...p.types,
          EIP712Domain: [{ name: "name", type: "string" }],
        },
      }),
    ],
    [
      "Add field order",
      (p) => withAddFields(p, (f) => [f[1]!, f[0]!, ...f.slice(2)]),
    ],
    [
      "Add field type",
      (p) =>
        withAddFields(p, (f) =>
          f.map((x) => (x.name === "keyType" ? { ...x, type: "uint256" } : x)),
        ),
    ],
    [
      "extra Add field",
      (p) => withAddFields(p, (f) => [...f, { name: "extra", type: "bytes" }]),
    ],
    [
      "missing Add field",
      (p) => withAddFields(p, (f) => f.filter((x) => x.name !== "deadline")),
    ],
    ["metadata type", (p) => withMessage(p, { metadataType: 0 })],
    ["metadata encoding", (p) => withMessage(p, { metadata: "not-hex" })],
    ["fractional nonce", (p) => withMessage(p, { nonce: 1.5 })],
    ["string nonce", (p) => withMessage(p, { nonce: "0" })],
    ["negative nonce", (p) => withMessage(p, { nonce: -1 })],
    ["string key type", (p) => withMessage(p, { keyType: "1" })],
    [
      "deadline past the prepare window",
      (p) =>
        withMessage(p, {
          deadline: FIXED_NOW_SECONDS + FIXTURE_PREPARE_TTL_SECONDS + 1,
        }),
    ],
    [
      "far-future deadline",
      (p) => withMessage(p, { deadline: FIXED_NOW_SECONDS + 365 * 86400 }),
    ],
    ["string deadline", (p) => withMessage(p, { deadline: "1" })],
  ])("rejects a tampered %s", (_label, tamper) => {
    expect(() =>
      assertKeyGatewayAdd(
        tamper(makeAddPayload(1, TEST_SIGNER_PUBLIC_KEY)),
        expected,
      ),
    ).toThrow(expect.objectContaining({ code: "payload_invalid" }));
  });
});

describe("signSignerLink", () => {
  it("signs both KeyGateway Adds and the SIWE token with the custody key", async () => {
    const prepare = makePrepare();
    const request = await signSignerLink({
      phrase: TEST_PHRASE,
      fid: TEST_FID,
      authAddress: TEST_AUTH_ACCOUNT.address,
      prepare,
      now: FIXED_NOW,
    });

    expect(request.prepare_id).toBe("prep_1");
    await expect(
      recoverTypedDataAddress({
        ...typedDataArgs(prepare.typed_data.signer),
        signature: request.signer_add_signature,
      } as Parameters<typeof recoverTypedDataAddress>[0]),
    ).resolves.toBe(TEST_CUSTODY);
    await expect(
      recoverTypedDataAddress({
        ...typedDataArgs(prepare.typed_data.auth_address),
        signature: request.auth_address_add_signature,
      } as Parameters<typeof recoverTypedDataAddress>[0]),
    ).resolves.toBe(TEST_CUSTODY);

    const { message, signature } = decodeHqa1(request.protocol_auth_token);
    await expect(recoverMessageAddress({ message, signature })).resolves.toBe(
      TEST_CUSTODY,
    );
    expect(message).toContain(`farcaster://fid/${TEST_FID}`);

    // Nothing in the outgoing request can contain the phrase.
    const serialized = JSON.stringify(request);
    for (const word of ["test test", "junk"]) {
      expect(serialized).not.toContain(word);
    }
  });

  it("caps the custody-signed register token at the 5 min login TTL", async () => {
    // A prepare window longer than 5 min must not stretch the token (L5).
    const prepare = makePrepare();
    prepare.expires_at = FIXED_NOW_SECONDS + ONE_HOUR_SECONDS;
    prepare.protocol_auth = {
      ...prepare.protocol_auth,
      expires_at: FIXED_NOW_SECONDS + ONE_HOUR_SECONDS,
    };
    const request = await signSignerLink({
      phrase: TEST_PHRASE,
      fid: TEST_FID,
      authAddress: TEST_AUTH_ACCOUNT.address,
      prepare,
      now: FIXED_NOW,
    });
    const { message } = decodeHqa1(request.protocol_auth_token);
    const expiry = new Date(
      (FIXED_NOW_SECONDS + LOGIN_TTL_SECONDS) * 1000,
    ).toISOString();
    expect(message).toContain(`Expiration Time: ${expiry}`);
  });

  it("refuses an Add whose deadline outlives the prepare window without deriving keys", async () => {
    const prepare = makePrepare();
    prepare.typed_data.signer = withMessage(prepare.typed_data.signer, {
      deadline: prepare.expires_at + 1,
    });
    jest.mocked(mnemonicToAccount).mockClear();
    await expectCode(
      signSignerLink({
        phrase: TEST_PHRASE,
        fid: TEST_FID,
        authAddress: TEST_AUTH_ACCOUNT.address,
        prepare,
        now: FIXED_NOW,
      }),
      "payload_invalid",
    );
    expect(mnemonicToAccount).not.toHaveBeenCalled();
  });

  it("also signs the Direct Casts generateToken request with custody", async () => {
    const request = await signSignerLink({
      phrase: TEST_PHRASE,
      fid: TEST_FID,
      authAddress: TEST_AUTH_ACCOUNT.address,
      prepare: makePrepare(),
      now: FIXED_NOW,
    });
    expect(request.dc_auth_request?.method).toBe("generateToken");
    expect(request.dc_auth_request?.params.timestamp).toBe(FIXED_NOW.getTime());
    await expect(
      recoverMessageAddress({
        message: canonicalizeAuthRequest(request.dc_auth_request),
        signature: decodeEip191(request.dc_auth_signature ?? ""),
      }),
    ).resolves.toBe(TEST_CUSTODY);
  });

  it("accepts the unpadded 20-byte auth address key", async () => {
    const prepare = makePrepare();
    prepare.typed_data.auth_address = makeAddPayload(
      2,
      TEST_AUTH_ACCOUNT.address.toLowerCase(),
    );
    await expect(
      signSignerLink({
        phrase: TEST_PHRASE,
        fid: TEST_FID,
        authAddress: TEST_AUTH_ACCOUNT.address,
        prepare,
        now: FIXED_NOW,
      }),
    ).resolves.toMatchObject({ prepare_id: "prep_1" });
  });

  it("rejects a phrase that doesn't control the custody address", async () => {
    await expectCode(
      signSignerLink({
        phrase: OTHER_PHRASE,
        fid: TEST_FID,
        authAddress: TEST_AUTH_ACCOUNT.address,
        prepare: makePrepare(),
        now: FIXED_NOW,
      }),
      "phrase_mismatch",
    );
  });

  it("refuses to sign when the auth_address payload targets another key", async () => {
    const prepare = makePrepare();
    prepare.typed_data.auth_address = makeAddPayload(2, `0x${"99".repeat(20)}`);
    await expectCode(
      signSignerLink({
        phrase: TEST_PHRASE,
        fid: TEST_FID,
        authAddress: TEST_AUTH_ACCOUNT.address,
        prepare,
        now: FIXED_NOW,
      }),
      "payload_invalid",
    );
  });

  it.each([
    ["domain", { domain: "evil.example" }],
    ["uri", { uri: "https://evil.example" }],
  ])(
    "refuses a protocol_auth %s pointing at another origin without signing",
    async (_label, override) => {
      const base = makePrepare();
      const prepare = makePrepare({
        protocol_auth: { ...base.protocol_auth, ...override },
      });
      jest.mocked(mnemonicToAccount).mockClear();
      await expectCode(
        signSignerLink({
          phrase: TEST_PHRASE,
          fid: TEST_FID,
          authAddress: TEST_AUTH_ACCOUNT.address,
          prepare,
          now: FIXED_NOW,
        }),
        "payload_invalid",
      );
      expect(mnemonicToAccount).not.toHaveBeenCalled();
    },
  );

  it("refuses an expiring prepare", async () => {
    const soon = Math.floor(FIXED_NOW.getTime() / 1000) + 10;
    await expectCode(
      signSignerLink({
        phrase: TEST_PHRASE,
        fid: TEST_FID,
        authAddress: TEST_AUTH_ACCOUNT.address,
        prepare: makePrepare({ expires_at: soon }),
        now: FIXED_NOW,
      }),
      "prepare_expired",
    );
  });
});

describe("signMessagingToken", () => {
  it("signs only the generateToken request with the custody key", async () => {
    const body = await signMessagingToken({
      phrase: TEST_PHRASE,
      fid: TEST_FID,
      custodyAddress: TEST_CUSTODY,
      now: FIXED_NOW,
    });
    expect(Object.keys(body).sort()).toEqual(["dc_auth_request", "dc_auth_signature"]);
    await expect(
      recoverMessageAddress({
        message: canonicalizeAuthRequest(body.dc_auth_request),
        signature: decodeEip191(body.dc_auth_signature),
      }),
    ).resolves.toBe(TEST_CUSTODY);
    expect(JSON.stringify(body)).not.toContain("junk");
  });

  it("accepts a lowercase custody address", async () => {
    await expect(
      signMessagingToken({
        phrase: TEST_PHRASE,
        fid: TEST_FID,
        custodyAddress: TEST_CUSTODY.toLowerCase(),
        now: FIXED_NOW,
      }),
    ).resolves.toHaveProperty("dc_auth_signature");
  });

  it("rejects a phrase for another account without echoing it", async () => {
    const promise = signMessagingToken({
      phrase: OTHER_PHRASE,
      fid: TEST_FID,
      custodyAddress: TEST_CUSTODY,
      now: FIXED_NOW,
    });
    await expectCode(promise, "phrase_mismatch");
    const error: unknown = await promise.catch((e: unknown) => e);
    for (const word of OTHER_PHRASE.split(" ").slice(0, 3)) {
      expect(String((error as Error).message)).not.toContain(word);
    }
  });

  it("rejects an invalid phrase or custody address before deriving keys", async () => {
    await expectCode(
      signMessagingToken({
        phrase: "test test test",
        fid: TEST_FID,
        custodyAddress: TEST_CUSTODY,
      }),
      "phrase_invalid",
    );
    const derive = jest.mocked(mnemonicToAccount);
    derive.mockClear();
    await expectCode(
      signMessagingToken({ phrase: TEST_PHRASE, fid: TEST_FID, custodyAddress: "" }),
      "payload_invalid",
    );
    expect(derive).not.toHaveBeenCalled();
  });
});

describe("pollSignerStatus", () => {
  function status(
    s: SignerStatusResponse["status"],
    extra: Partial<SignerStatusResponse> = {},
  ) {
    return {
      prepare_id: "prep_1",
      status: s,
      signer_tx_hash: null,
      auth_address_tx_hash: null,
      error: null,
      ...extra,
    } as SignerStatusResponse;
  }

  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: jest.fn(async (ms: number) => {
        t += ms;
      }),
    };
  }

  it("polls every 3s until approved", async () => {
    const clock = fakeClock();
    const getStatus = jest
      .fn<(id: string) => Promise<SignerStatusResponse>>()
      .mockResolvedValueOnce(status("pending"))
      .mockResolvedValueOnce(status("submitted"))
      .mockResolvedValueOnce(status("approved"));
    const result = await pollSignerStatus({
      prepareId: "prep_1",
      getStatus,
      ...clock,
    });
    expect(result.status).toBe("approved");
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(clock.sleep).toHaveBeenCalledWith(3000);
  });

  it("times out after 3 minutes", async () => {
    const clock = fakeClock();
    const getStatus = jest
      .fn<(id: string) => Promise<SignerStatusResponse>>()
      .mockResolvedValue(status("submitted"));
    await expectCode(
      pollSignerStatus({ prepareId: "prep_1", getStatus, ...clock }),
      "link_timeout",
    );
    expect(clock.now()).toBeLessThanOrEqual(180_000);
    expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(60);
  });

  it("surfaces failed and cancelled", async () => {
    const clock = fakeClock();
    const failed = jest
      .fn<(id: string) => Promise<SignerStatusResponse>>()
      .mockResolvedValue(status("failed", { error: "tx_reverted" }));
    await expect(
      pollSignerStatus({ prepareId: "prep_1", getStatus: failed, ...clock }),
    ).rejects.toMatchObject({ code: "link_failed", detail: "tx_reverted" });

    const never = jest.fn<(id: string) => Promise<SignerStatusResponse>>();
    await expectCode(
      pollSignerStatus({
        prepareId: "prep_1",
        getStatus: never,
        isCancelled: () => true,
        ...clock,
      }),
      "cancelled",
    );
    expect(never).not.toHaveBeenCalled();
  });
});
