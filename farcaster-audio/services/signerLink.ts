/**
 * One-time on-chain signer link using the Farcaster recovery phrase.
 *
 * Phrase hygiene (auth contract §5): the phrase arrives as a function
 * argument, is turned into a viem account, used for exactly three
 * signatures — two `signTypedData` KeyGateway adds plus one SIWE
 * `signMessage` — and one EIP-191 Direct Casts `generateToken` request
 * (messaging-design §3), and every reference is dropped when
 * `signSignerLink` returns. `signMessagingToken` (the "Enable messages"
 * flow for already-linked users) signs only that token request. The phrase
 * is never logged, stored, put in an error message, or sent over the
 * network — only public keys and signatures leave this module.
 *
 * Before signing anything the device checks that the server-built payloads
 * really are KeyGateway `Add` requests for this custody address and the
 * expected keys: pinned domain, the exact `Add` struct and nothing else,
 * signed-key-request metadata, an integer nonce and a short deadline. A
 * tampered `typed_data` (e.g. an IdRegistry `Transfer`, or an extra struct
 * smuggled into `types`) would otherwise let a compromised backend take over
 * the FID or obtain a long-lived custody signature.
 */

import "@/utils/cryptoPolyfill";
import { isAddressEqual, type Hex } from "viem";
import { english, mnemonicToAccount } from "viem/accounts";
import {
  PROTOCOL_AUTH_CHAIN_ID,
  PROTOCOL_AUTH_DOMAIN,
  PROTOCOL_AUTH_LOGIN_TTL_SECONDS,
  PROTOCOL_AUTH_URI,
  signProtocolAuthToken,
} from "@/services/protocolAuth";
import { signMessagingTokenRequest } from "@/services/messagingToken";
import type {
  Eip712Payload,
  SignerPrepareResponse,
  SignerRegisterRequest,
  SignerStatusResponse,
} from "@/types/api";
import type { EnableMessagingRequest } from "@/types/messages";

export const KEY_GATEWAY_ADDRESS = "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B";
const KEY_GATEWAY_DOMAIN_NAME = "Farcaster KeyGateway";
const KEY_GATEWAY_DOMAIN_VERSION = "1";
const KEY_GATEWAY_DOMAIN_FIELDS: ReadonlyArray<{ name: string; type: string }> =
  [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
    { name: "chainId", type: "uint256" },
    { name: "verifyingContract", type: "address" },
  ];
const EIP712_DOMAIN_TYPE = "EIP712Domain";
const ADD_PRIMARY_TYPE = "Add";
/** KeyGateway `Add`, field for field and in order (KeyGateway ADD_TYPEHASH). */
const ADD_FIELDS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "owner", type: "address" },
  { name: "keyType", type: "uint32" },
  { name: "key", type: "bytes" },
  { name: "metadataType", type: "uint8" },
  { name: "metadata", type: "bytes" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
];
const METADATA_TYPE_SIGNED_KEY_REQUEST = 1;
const KEY_TYPE_ED25519 = 1;
const KEY_TYPE_AUTH_ADDRESS = 2;
/** KeyRegistry stores auth addresses as 12 zero bytes + the 20-byte address. */
const AUTH_ADDRESS_KEY_PADDING = "0".repeat(24);
/** The backend signs `Add` deadlines at most 1 h out; allow for clock skew. */
const MAX_ADD_DEADLINE_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;
const VALID_PHRASE_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);
const ENGLISH_WORDS = new Set(english);

export const SIGNER_STATUS_POLL_INTERVAL_MS = 3_000;
export const SIGNER_STATUS_TIMEOUT_MS = 3 * 60 * 1_000;
/** Leave this much of the prepare window for signing + relay. */
const PREPARE_EXPIRY_MARGIN_SECONDS = 30;
const MS_PER_SECOND = 1_000;

export type SignerLinkErrorCode =
  | "phrase_invalid"
  | "phrase_mismatch"
  | "payload_invalid"
  | "prepare_expired"
  | "link_failed"
  | "link_timeout"
  | "cancelled";

export class SignerLinkError extends Error {
  constructor(
    readonly code: SignerLinkErrorCode,
    message: string,
    /** Backend machine code when the link failed server-side. */
    readonly detail: string | null = null,
  ) {
    super(message);
    this.name = "SignerLinkError";
  }
}

/**
 * Canonical form of a typed phrase: lowercase words separated by single
 * spaces. Throws `phrase_invalid` (without echoing any of the input) when it
 * isn't a well-formed English BIP-39 phrase.
 */
export function normalizeRecoveryPhrase(raw: string): string {
  const words = raw.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!VALID_PHRASE_WORD_COUNTS.has(words.length)) {
    throw new SignerLinkError(
      "phrase_invalid",
      "A recovery phrase is 12 or 24 words. Check the word count.",
    );
  }
  if (!words.every((word) => ENGLISH_WORDS.has(word))) {
    throw new SignerLinkError(
      "phrase_invalid",
      "One or more words aren't recovery-phrase words. Check the spelling.",
    );
  }
  return words.join(" ");
}

/** Number of whitespace-separated words, for the on-screen counter only. */
export function countPhraseWords(raw: string): number {
  return raw.trim() ? raw.trim().split(/\s+/).length : 0;
}

function payloadError(reason: string): SignerLinkError {
  return new SignerLinkError(
    "payload_invalid",
    `The sign-in request from the server failed a safety check (${reason}). Nothing was signed.`,
  );
}

function asHex(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value)
    ? value.toLowerCase()
    : null;
}

function isSameFieldList(
  actual: { name: string; type: string }[] | undefined,
  expected: ReadonlyArray<{ name: string; type: string }>,
): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (field, i) =>
        field?.name === expected[i]?.name && field?.type === expected[i]?.type,
    )
  );
}

function isUint(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Latest `Add` deadline the device will sign: never past the prepare window,
 * and never more than 1 h (+ skew) out, whatever the server claims.
 */
export function latestAddDeadline(
  prepare: SignerPrepareResponse,
  now: Date = new Date(),
): number {
  const nowSeconds = Math.floor(now.getTime() / MS_PER_SECOND);
  return Math.min(
    prepare.expires_at,
    nowSeconds + MAX_ADD_DEADLINE_SECONDS + CLOCK_SKEW_SECONDS,
  );
}

/**
 * Reject anything that isn't exactly a KeyGateway `Add` for `owner`, with
 * the given key type and key bytes and a deadline no later than
 * `latestDeadline` (unix seconds). Exported for tests.
 */
export function assertKeyGatewayAdd(
  payload: Eip712Payload,
  expected: {
    owner: string;
    keyType: number;
    keys: string[];
    latestDeadline: number;
  },
): void {
  const { domain, message, types } = payload;

  const verifyingContract = asHex(domain.verifyingContract);
  const isPinnedDomain =
    Object.keys(domain).length === KEY_GATEWAY_DOMAIN_FIELDS.length &&
    domain.name === KEY_GATEWAY_DOMAIN_NAME &&
    domain.version === KEY_GATEWAY_DOMAIN_VERSION &&
    domain.chainId === PROTOCOL_AUTH_CHAIN_ID &&
    verifyingContract === KEY_GATEWAY_ADDRESS.toLowerCase();
  if (!isPinnedDomain) throw payloadError("domain");

  // viem derives EIP712Domain from `domain`; if the server sends it anyway it
  // must be the canonical one. Exactly one other struct: `Add`.
  const structNames = Object.keys(types).filter(
    (name) => name !== EIP712_DOMAIN_TYPE,
  );
  const isPinnedType =
    payload.primaryType === ADD_PRIMARY_TYPE &&
    structNames.length === 1 &&
    structNames[0] === ADD_PRIMARY_TYPE &&
    isSameFieldList(types[ADD_PRIMARY_TYPE], ADD_FIELDS) &&
    (types[EIP712_DOMAIN_TYPE] === undefined ||
      isSameFieldList(types[EIP712_DOMAIN_TYPE], KEY_GATEWAY_DOMAIN_FIELDS));
  if (!isPinnedType) throw payloadError("type");

  const owner = asHex(message.owner);
  if (!owner || owner !== expected.owner.toLowerCase()) {
    throw payloadError("owner");
  }
  if (message.keyType !== expected.keyType) throw payloadError("key type");
  const key = asHex(message.key);
  if (!key || !expected.keys.map((k) => k.toLowerCase()).includes(key)) {
    throw payloadError("key");
  }
  if (message.metadataType !== METADATA_TYPE_SIGNED_KEY_REQUEST) {
    throw payloadError("metadata type");
  }
  if (asHex(message.metadata) === null) throw payloadError("metadata");
  if (!isUint(message.nonce)) throw payloadError("nonce");
  if (!isUint(message.deadline) || message.deadline > expected.latestDeadline) {
    throw payloadError("deadline");
  }
}

/** Strip `EIP712Domain` (viem derives it from `domain`) and sign as-is. */
function toSignableTypedData(payload: Eip712Payload) {
  const { EIP712Domain: _ignored, ...types } = payload.types;
  return {
    domain: payload.domain,
    types,
    primaryType: payload.primaryType,
    message: payload.message,
  };
}

/** True when the prepare response is too close to expiry to finish signing. */
export function isPrepareExpiring(
  prepare: SignerPrepareResponse,
  now: Date = new Date(),
  marginSeconds = PREPARE_EXPIRY_MARGIN_SECONDS,
): boolean {
  const deadline = Math.min(
    prepare.expires_at,
    prepare.protocol_auth.expires_at,
  );
  return (
    deadline * MS_PER_SECOND - now.getTime() < marginSeconds * MS_PER_SECOND
  );
}

/**
 * Derive the custody account from the phrase, verify it owns the FID, and
 * produce the register request. The phrase is not retained.
 */
export async function signSignerLink(params: {
  phrase: string;
  fid: number;
  authAddress: Hex;
  prepare: SignerPrepareResponse;
  now?: Date;
}): Promise<SignerRegisterRequest> {
  const { prepare, fid, authAddress } = params;
  if (isPrepareExpiring(prepare, params.now)) {
    throw new SignerLinkError(
      "prepare_expired",
      "This sign-in request expired. Start again.",
    );
  }

  // The custody key is the user's root key: never let the server point its
  // SIWE signature at another origin (it would be a valid SIWF credential
  // there).
  if (
    prepare.protocol_auth.domain !== PROTOCOL_AUTH_DOMAIN ||
    prepare.protocol_auth.uri !== PROTOCOL_AUTH_URI
  ) {
    throw payloadError("auth domain");
  }

  const custody = prepare.custody_address;
  const latestDeadline = latestAddDeadline(prepare, params.now);
  assertKeyGatewayAdd(prepare.typed_data.signer, {
    owner: custody,
    keyType: KEY_TYPE_ED25519,
    keys: [prepare.signer_public_key],
    latestDeadline,
  });
  const authAddressHex = authAddress.toLowerCase().slice(2);
  assertKeyGatewayAdd(prepare.typed_data.auth_address, {
    owner: custody,
    keyType: KEY_TYPE_AUTH_ADDRESS,
    keys: [
      `0x${authAddressHex}`,
      `0x${AUTH_ADDRESS_KEY_PADDING}${authAddressHex}`,
    ],
    latestDeadline,
  });

  // Scoped so the account (and with it the derived private key) is
  // unreachable as soon as this block finishes.
  let account: ReturnType<typeof mnemonicToAccount> | null = mnemonicToAccount(
    normalizeRecoveryPhrase(params.phrase),
  );
  try {
    assertPhraseControlsCustody(account, custody);
    const signerAddSignature = await account.signTypedData(
      toSignableTypedData(prepare.typed_data.signer),
    );
    const authAddressAddSignature = await account.signTypedData(
      toSignableTypedData(prepare.typed_data.auth_address),
    );
    const protocolAuthToken = await signProtocolAuthToken({
      signer: account,
      fid,
      nonce: prepare.protocol_auth.nonce,
      // Only has to survive the immediate register call (L5).
      ttlSeconds: PROTOCOL_AUTH_LOGIN_TTL_SECONDS,
      challengeExpiresAt: prepare.protocol_auth.expires_at,
      now: params.now,
    });
    const messagingToken = await signMessagingTokenRequest(
      account,
      params.now,
    );
    return {
      prepare_id: prepare.prepare_id,
      signer_add_signature: signerAddSignature,
      auth_address_add_signature: authAddressAddSignature,
      protocol_auth_token: protocolAuthToken,
      ...messagingToken,
    };
  } finally {
    account = null;
  }
}

function assertPhraseControlsCustody(
  account: { address: Hex },
  custody: string,
): void {
  if (!isAddressEqual(account.address, custody as Hex)) {
    throw new SignerLinkError(
      "phrase_mismatch",
      "That phrase doesn't control this Farcaster account. Make sure it's your Farcaster recovery phrase, not a wallet phrase.",
    );
  }
}

/**
 * "Enable messages" for a user whose signer is already linked: derive the
 * custody account, check it owns the FID, and sign only the Direct Casts
 * `generateToken` request (no signer add). The phrase is not retained.
 */
export async function signMessagingToken(params: {
  phrase: string;
  fid: number;
  custodyAddress: string;
  now?: Date;
}): Promise<EnableMessagingRequest> {
  if (!asHex(params.custodyAddress)) throw payloadError("custody");
  let account: ReturnType<typeof mnemonicToAccount> | null = mnemonicToAccount(
    normalizeRecoveryPhrase(params.phrase),
  );
  try {
    assertPhraseControlsCustody(account, params.custodyAddress);
    return await signMessagingTokenRequest(account, params.now);
  } finally {
    account = null;
  }
}

/**
 * Poll `GET /v1/auth/signer/status` every 3s (3 min cap) until `approved`.
 * Throws `link_failed` / `link_timeout` / `cancelled`.
 */
export async function pollSignerStatus(params: {
  prepareId: string;
  getStatus: (prepareId: string) => Promise<SignerStatusResponse>;
  onStatus?: (status: SignerStatusResponse) => void;
  isCancelled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  timeoutMs?: number;
}): Promise<SignerStatusResponse> {
  const sleep =
    params.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = params.now ?? Date.now;
  const intervalMs = params.intervalMs ?? SIGNER_STATUS_POLL_INTERVAL_MS;
  const deadline = now() + (params.timeoutMs ?? SIGNER_STATUS_TIMEOUT_MS);

  for (;;) {
    if (params.isCancelled?.()) {
      throw new SignerLinkError("cancelled", "Sign-in was cancelled.");
    }
    const status = await params.getStatus(params.prepareId);
    params.onStatus?.(status);
    if (status.status === "approved") return status;
    if (status.status === "failed") {
      throw new SignerLinkError(
        "link_failed",
        "Linking Juke to your account failed on-chain. Try again.",
        status.error,
      );
    }
    if (now() + intervalMs > deadline) {
      throw new SignerLinkError(
        "link_timeout",
        "Linking is taking longer than expected. Try signing in again in a few minutes.",
      );
    }
    await sleep(intervalMs);
  }
}
