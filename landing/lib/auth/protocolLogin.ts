/**
 * Web sign-in against the frozen Hypersnap auth contract
 * (`/v1/auth/protocol`, `/v1/auth/signer/{prepare,register,status}`).
 *
 * Two paths:
 *   1. Returning browser — the stored auth address signs an `hqa1` token and
 *      `POST /v1/auth/protocol` mints the session. No phrase.
 *   2. First link — the recovery phrase is turned into the custody account,
 *      which signs the two KeyGateway `Add` payloads, an `hqa1` token and the
 *      Direct Cast `generateToken` request. The backend relays `addFor` and we
 *      poll until the keys are on-chain, then sign in as in path 1 (the status
 *      poll reports progress only and never hands out a session).
 *
 * {@link signMessagingToken} is the messaging-only variant: it re-derives
 * custody to sign just the `generateToken` request when messaging access is
 * missing or expired.
 *
 * Phrase hygiene (contract section 5): both signers take the phrase
 * as an argument, derives the account, signs, and keeps no reference. The
 * phrase is never passed to `fetch`, a store, storage or a logger here — only
 * public keys and signatures leave this module.
 */

import type { Hex, LocalAccount } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { API_BASE_URL } from "@/lib/api/client";
import { HYPERSNAP_HTTP_URL } from "@/lib/hypersnap/config";
import type { EnableMessagingRequest } from "@/lib/api/messages.types";
import { signMessagingTokenRequest } from "@/lib/auth/messagingToken";
import type {
  Eip712Payload,
  LoginResponse,
  NonceResponse,
  SignerPrepareResponse,
  SignerRegisterRequest,
  SignerRegisterResponse,
  SignerStatusResponse,
} from "@/lib/api/types";
import {
  DEFAULT_PROTOCOL_TOKEN_TTL_SECONDS,
  PROTOCOL_AUTH_CHAIN_ID,
  PROTOCOL_AUTH_DOMAIN,
  PROTOCOL_AUTH_URI,
  signProtocolToken,
} from "@/lib/auth/protocolToken";

/** Contract: clients poll signer status every 3 s for at most 3 min. */
export const SIGNER_STATUS_POLL_INTERVAL_MS = 3_000;
export const SIGNER_STATUS_TIMEOUT_MS = 3 * 60 * 1_000;

type FetchLike = typeof fetch;

// ---------------------------------------------------------------------------
// Pinned KeyGateway `Add` shape — the only typed data custody may sign here
// ---------------------------------------------------------------------------

/** Farcaster KeyGateway on Optimism; the `Add` payloads' `verifyingContract`. */
export const KEY_GATEWAY_ADDRESS: Hex = "0x00000000fC56947c7E7183f8Ca4B62398CaAdf0B";
const KEY_GATEWAY_DOMAIN_NAME = "Farcaster KeyGateway";
const KEY_GATEWAY_DOMAIN_VERSION = "1";
const KEY_GATEWAY_DOMAIN_FIELD_COUNT = 4;
const ADD_PRIMARY_TYPE = "Add";
const ADD_FIELDS: ReadonlyArray<{ name: string; type: string }> = [
  { name: "owner", type: "address" },
  { name: "keyType", type: "uint32" },
  { name: "key", type: "bytes" },
  { name: "metadataType", type: "uint8" },
  { name: "metadata", type: "bytes" },
  { name: "nonce", type: "uint256" },
  { name: "deadline", type: "uint256" },
];
/** KeyRegistry key types: Juke's Ed25519 app signer and this browser's address. */
const KEY_TYPE_ED25519 = 1;
const KEY_TYPE_AUTH_ADDRESS = 2;
const METADATA_TYPE_SIGNED_KEY_REQUEST = 1;
const ED25519_PUBLIC_KEY_PATTERN = /^0x[0-9a-f]{64}$/i;
/** KeyRegistry stores a keyType 2 key as the address left-padded to 32 bytes. */
const AUTH_ADDRESS_KEY_PADDING = "0".repeat(24);
/** The backend signs `Add` deadlines at most 1 h out; allow for clock skew. */
const MAX_ADD_DEADLINE_SECONDS = 60 * 60;
const CLOCK_SKEW_SECONDS = 5 * 60;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A failed auth request, carrying the contract's machine-readable code. */
export class AuthRequestError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message?: string) {
    super(message ?? (code ? `${code} (${status})` : `Request failed (${status})`));
    this.name = "AuthRequestError";
    this.status = status;
    this.code = code;
  }
}

/** This browser's auth address isn't on-chain for the FID — link it first. */
export class LinkRequiredError extends Error {
  constructor() {
    super("This browser isn't linked to your Farcaster account yet.");
    this.name = "LinkRequiredError";
  }
}

/** The phrase derived an address that isn't the FID's custody address. */
export class CustodyMismatchError extends Error {
  constructor() {
    super(
      "That recovery phrase doesn't control this Farcaster account. Use the phrase for the account's custody address.",
    );
    this.name = "CustodyMismatchError";
  }
}

/** The phrase isn't a valid BIP-39 mnemonic. */
export class InvalidRecoveryPhraseError extends Error {
  constructor() {
    super("That doesn't look like a valid recovery phrase. Check the words and their order.");
    this.name = "InvalidRecoveryPhraseError";
  }
}

export class SignerLinkFailedError extends Error {
  readonly code: string | null;

  constructor(code: string | null) {
    super(
      code === "timeout"
        ? "Linking is taking longer than expected. Try signing in again in a minute."
        : `Linking failed${code ? ` (${code})` : ""}. Try again.`,
    );
    this.name = "SignerLinkFailedError";
    this.code = code;
  }
}

/**
 * The server asked custody to sign something other than the expected KeyGateway
 * `Add` payloads or Juke token. Thrown before anything is signed.
 */
export class UnexpectedSigningRequestError extends Error {
  constructor(reason: string) {
    super(
      `Juke asked this tab to sign something unexpected (${reason}), so nothing was signed. Try again later.`,
    );
    this.name = "UnexpectedSigningRequestError";
  }
}

export class FarcasterUserNotFoundError extends Error {
  constructor(query: string) {
    super(`No Farcaster account found for "${query}".`);
    this.name = "FarcasterUserNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface AuthApiOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
  /**
   * `true` (default): the backend sets the HttpOnly refresh cookie and the
   * body's `refresh_token` is null. `false`: the refresh token comes back in
   * the body — for third-party iframes (the embed) where storage
   * partitioning makes the cookie unreliable.
   */
  readonly useCookie?: boolean;
}

async function postJson<T>(
  path: string,
  body: unknown,
  options: AuthApiOptions = {},
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.baseUrl ?? API_BASE_URL}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseResponse<T>(response);
}

async function getJson<T>(path: string, options: AuthApiOptions = {}): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${options.baseUrl ?? API_BASE_URL}${path}`, {
    method: "GET",
    credentials: "include",
  });
  return parseResponse<T>(response);
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // A non-JSON body (e.g. a proxy error page) carries no contract code.
  }
  if (!response.ok) {
    throw new AuthRequestError(response.status, extractErrorCode(body));
  }
  return body as T;
}

/**
 * Pull the contract's machine code out of an error body. FastAPI may carry it
 * as `{ detail: "code" }`, `{ detail: { code } }` / `{ detail: { error } }`,
 * or a bare `{ error }` / `{ code }`.
 */
export function extractErrorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  const detail = record.detail;
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const nested = detail as Record<string, unknown>;
    if (typeof nested.code === "string") return nested.code;
    if (typeof nested.error === "string") return nested.error;
  }
  if (typeof record.code === "string") return record.code;
  if (typeof record.error === "string") return record.error;
  return null;
}

// ---------------------------------------------------------------------------
// Contract endpoints
// ---------------------------------------------------------------------------

export function fetchAuthNonce(options?: AuthApiOptions): Promise<NonceResponse> {
  return postJson<NonceResponse>("/v1/auth/siwf/nonce", {}, options);
}

export function loginWithProtocolToken(
  token: string,
  options?: AuthApiOptions,
): Promise<LoginResponse> {
  return postJson<LoginResponse>(
    "/v1/auth/protocol",
    { token, use_cookie: options?.useCookie ?? true },
    options,
  );
}

export function prepareSignerLink(
  params: { fid: number; authAddress: Hex },
  options?: AuthApiOptions,
): Promise<SignerPrepareResponse> {
  return postJson<SignerPrepareResponse>(
    "/v1/auth/signer/prepare",
    { fid: params.fid, auth_address: params.authAddress.toLowerCase() },
    options,
  );
}

export function registerSignerLink(
  body: SignerRegisterRequest,
  options?: AuthApiOptions,
): Promise<SignerRegisterResponse> {
  return postJson<SignerRegisterResponse>("/v1/auth/signer/register", body, options);
}

export function fetchSignerLinkStatus(
  prepareId: string,
  options?: AuthApiOptions,
): Promise<SignerStatusResponse> {
  return getJson<SignerStatusResponse>(
    `/v1/auth/signer/status?prepare_id=${encodeURIComponent(prepareId)}`,
    options,
  );
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

/**
 * Sign in with this browser's auth address. Throws {@link LinkRequiredError}
 * when there is no stored key or the backend says `signer_not_linked`. Any
 * other failure (e.g. an unrelated 403) passes through, so it never routes the
 * user to recovery-phrase entry.
 */
export async function signInWithAuthAddress(
  params: { fid: number; account: LocalAccount | null },
  options?: AuthApiOptions,
): Promise<LoginResponse> {
  if (!params.account) throw new LinkRequiredError();
  const { nonce } = await fetchAuthNonce(options);
  const token = await signProtocolToken({
    signer: params.account,
    fid: params.fid,
    nonce,
  });
  try {
    return await loginWithProtocolToken(token, options);
  } catch (err) {
    if (err instanceof AuthRequestError && err.code === "signer_not_linked") {
      throw new LinkRequiredError();
    }
    throw err;
  }
}

/** RPC lag after approval: try for ~10s before giving up. */
export const POST_LINK_LOGIN_ATTEMPTS = 5;
export const POST_LINK_LOGIN_RETRY_DELAY_MS = 2_000;

export interface PostLinkLoginOptions extends AuthApiOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  readonly signal?: AbortSignal;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * First sign-in right after the link is approved: the new auth address signs
 * in like a returning browser. `signer_not_linked` is retried briefly because
 * the backend's KeyRegistry read can trail the approval by a block or two.
 */
export async function signInWithAuthAddressAfterLink(
  params: { fid: number; account: LocalAccount },
  options: PostLinkLoginOptions = {},
): Promise<LoginResponse> {
  const attempts = Math.max(options.attempts ?? POST_LINK_LOGIN_ATTEMPTS, 1);
  const delayMs = options.delayMs ?? POST_LINK_LOGIN_RETRY_DELAY_MS;
  const sleep = options.sleep ?? abortableSleep;

  for (let attempt = 1; ; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await signInWithAuthAddress(params, options);
    } catch (err) {
      if (!(err instanceof LinkRequiredError) || attempt >= attempts) throw err;
    }
    await sleep(delayMs, options.signal);
  }
}

export interface SignedSignerLink {
  readonly signerAddSignature: Hex;
  readonly authAddressAddSignature: Hex;
  readonly protocolAuthToken: string;
  /** Custody-signed Direct Cast token request, forwarded on register. */
  readonly messagingToken: EnableMessagingRequest;
}

/**
 * Derive the custody account from the recovery phrase, check it controls the
 * FID, and sign everything the register call needs. The phrase is only read
 * here; the derived account goes out of scope when this resolves.
 *
 * The API is not trusted with custody authority: both payloads must match the
 * pinned KeyGateway `Add` shape ({@link assertKeyGatewayAdd}) and the token is
 * signed with the client's own SIWE domain/uri. Nothing is signed otherwise.
 */
export async function signSignerLink(params: {
  fid: number;
  /** This browser's auth address — the only keyType 2 key custody may add. */
  authAddress: Hex;
  recoveryPhrase: string;
  prepare: SignerPrepareResponse;
  now?: Date;
}): Promise<SignedSignerLink> {
  const { prepare } = params;
  const custody = deriveCustodyAccount(params.recoveryPhrase, prepare.custody_address);

  const latestDeadline = latestAddDeadline(prepare, params.now);
  if (!ED25519_PUBLIC_KEY_PATTERN.test(prepare.signer_public_key)) {
    throw new UnexpectedSigningRequestError("signer key");
  }
  const signerAdd = toSignableTypedData(prepare.typed_data.signer);
  assertKeyGatewayAdd(signerAdd, {
    owner: custody.address,
    keyType: KEY_TYPE_ED25519,
    key: prepare.signer_public_key,
    latestDeadline,
  });
  const authAddressAdd = toSignableTypedData(prepare.typed_data.auth_address);
  assertKeyGatewayAdd(authAddressAdd, {
    owner: custody.address,
    keyType: KEY_TYPE_AUTH_ADDRESS,
    key: toAuthAddressKey(params.authAddress),
    latestDeadline,
  });
  const { protocol_auth: protocolAuth } = prepare;
  if (
    protocolAuth.domain.toLowerCase() !== PROTOCOL_AUTH_DOMAIN.toLowerCase() ||
    protocolAuth.uri !== PROTOCOL_AUTH_URI
  ) {
    throw new UnexpectedSigningRequestError("sign-in domain");
  }

  const signerAddSignature = await custody.signTypedData(signerAdd);
  const authAddressAddSignature = await custody.signTypedData(authAddressAdd);
  // `domain`/`uri` default to the client constants, never the server's.
  const protocolAuthToken = await signProtocolToken({
    signer: custody,
    fid: params.fid,
    nonce: protocolAuth.nonce,
    issuedAt: params.now,
    // Only has to survive the immediate register call (L5).
    ttlSeconds: DEFAULT_PROTOCOL_TOKEN_TTL_SECONDS,
    notAfter: new Date(protocolAuth.expires_at * 1000),
  });
  const messagingToken = await signMessagingTokenRequest(custody, params.now);
  return { signerAddSignature, authAddressAddSignature, protocolAuthToken, messagingToken };
}

/**
 * Messaging-only re-enable: derive custody, check it controls the FID's
 * `custodyAddress`, and sign just the `generateToken` request. The phrase is
 * only read here and never appears in a thrown error.
 */
export async function signMessagingToken(params: {
  phrase: string;
  fid: number;
  custodyAddress: string;
  now?: Date;
}): Promise<EnableMessagingRequest> {
  const custody = deriveCustodyAccount(params.phrase, params.custodyAddress);
  return signMessagingTokenRequest(custody, params.now);
}

/** Phrase -> custody account, or a phrase-free error. */
function deriveCustodyAccount(recoveryPhrase: string, custodyAddress: string): LocalAccount {
  let custody: LocalAccount;
  try {
    custody = mnemonicToAccount(normalizeRecoveryPhrase(recoveryPhrase));
  } catch {
    throw new InvalidRecoveryPhraseError();
  }
  if (custody.address.toLowerCase() !== custodyAddress.toLowerCase()) {
    throw new CustodyMismatchError();
  }
  return custody;
}

/** The 32-byte KeyRegistry key for an auth address (12 zero bytes + address). */
export function toAuthAddressKey(address: Hex): Hex {
  return `0x${AUTH_ADDRESS_KEY_PADDING}${address.slice(2).toLowerCase()}`;
}

/**
 * Latest `Add` deadline (unix seconds) custody may sign for this prepare: no
 * later than the prepare itself expires, and never beyond the backend's 1 h
 * horizon plus clock skew. Mirrors the mobile client's `latestAddDeadline`.
 */
export function latestAddDeadline(
  prepare: Pick<SignerPrepareResponse, "expires_at">,
  now: Date = new Date(),
): number {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  return Math.min(
    prepare.expires_at,
    nowSeconds + MAX_ADD_DEADLINE_SECONDS + CLOCK_SKEW_SECONDS,
  );
}

/**
 * Throw {@link UnexpectedSigningRequestError} unless `typed` is exactly a
 * KeyGateway `Add` on Optimism by `owner` for `keyType`/`key`, with
 * signed-key-request metadata and a deadline no later than `latestDeadline`
 * (see {@link latestAddDeadline}). Stops a hostile API from having custody
 * sign an IdRegistry `Transfer`, a KeyRegistry `Remove`, an `Add` for someone
 * else's key, or a long-lived `Add` that outlives the prepare.
 */
export function assertKeyGatewayAdd(
  typed: SignableTypedData,
  expected: { owner: Hex; keyType: number; key: string; latestDeadline: number },
): void {
  const { domain, types, primaryType, message } = typed;
  const isPinnedDomain =
    Object.keys(domain).length === KEY_GATEWAY_DOMAIN_FIELD_COUNT &&
    domain.name === KEY_GATEWAY_DOMAIN_NAME &&
    domain.version === KEY_GATEWAY_DOMAIN_VERSION &&
    domain.chainId === PROTOCOL_AUTH_CHAIN_ID &&
    isSameHex(domain.verifyingContract, KEY_GATEWAY_ADDRESS);
  if (!isPinnedDomain) throw new UnexpectedSigningRequestError("domain");

  const fields = types[ADD_PRIMARY_TYPE];
  const isPinnedType =
    primaryType === ADD_PRIMARY_TYPE &&
    Object.keys(types).length === 1 &&
    fields?.length === ADD_FIELDS.length &&
    fields.every(
      (field, i) =>
        field.name === ADD_FIELDS[i]?.name && field.type === ADD_FIELDS[i]?.type,
    );
  if (!isPinnedType) throw new UnexpectedSigningRequestError("message type");

  if (!isSameHex(message.owner, expected.owner)) {
    throw new UnexpectedSigningRequestError("owner");
  }
  if (message.keyType !== BigInt(expected.keyType)) {
    throw new UnexpectedSigningRequestError("key type");
  }
  if (!isSameHex(message.key, expected.key)) {
    throw new UnexpectedSigningRequestError("key");
  }
  if (message.metadataType !== BigInt(METADATA_TYPE_SIGNED_KEY_REQUEST)) {
    throw new UnexpectedSigningRequestError("metadata type");
  }
  if (
    typeof message.deadline !== "bigint" ||
    message.deadline > BigInt(expected.latestDeadline)
  ) {
    throw new UnexpectedSigningRequestError("deadline");
  }
}

function isSameHex(value: unknown, expected: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expected.toLowerCase();
}

/** Collapse whitespace/case so a pasted or wrapped phrase still derives. */
export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

/** Count words without retaining the phrase — drives the submit button. */
export function countRecoveryPhraseWords(phrase: string): number {
  const trimmed = phrase.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Coerce JSON integers into `bigint` for every `uint*`/`int*` field so viem
 * encodes them exactly, and drop a server-supplied `EIP712Domain` (viem
 * derives it from `domain`).
 */
export interface SignableTypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export function toSignableTypedData(payload: Eip712Payload): SignableTypedData {
  const types: Record<string, Array<{ name: string; type: string }>> = {};
  for (const [name, fields] of Object.entries(payload.types)) {
    if (name === "EIP712Domain") continue;
    types[name] = fields.map((field) => ({ name: field.name, type: field.type }));
  }
  const fields = types[payload.primaryType];
  if (!fields) {
    throw new Error(`typed data is missing the ${payload.primaryType} type`);
  }
  const message: Record<string, unknown> = { ...payload.message };
  for (const field of fields) {
    if (/^u?int\d*$/.test(field.type)) {
      message[field.name] = toBigInt(message[field.name]);
    }
  }
  const domain: Record<string, unknown> = { ...payload.domain };
  if (domain.chainId !== undefined) domain.chainId = Number(domain.chainId);
  return { domain, types, primaryType: payload.primaryType, message };
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-f]+|\d+)$/i.test(value)) {
    return BigInt(value);
  }
  throw new Error("typed data carries a non-integer value for an integer field");
}

export interface PollSignerLinkOptions extends AuthApiOptions {
  readonly intervalMs?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onStatus?: (status: SignerStatusResponse["status"]) => void;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Poll `GET /v1/auth/signer/status` until `approved` (resolves with the
 * response) or `failed` / timeout (throws {@link SignerLinkFailedError}).
 */
export async function pollSignerLinkUntilApproved(
  prepareId: string,
  options: PollSignerLinkOptions = {},
): Promise<SignerStatusResponse> {
  const intervalMs = options.intervalMs ?? SIGNER_STATUS_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? SIGNER_STATUS_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadline = now() + timeoutMs;

  for (;;) {
    throwIfAborted(options.signal);
    const status = await fetchSignerLinkStatus(prepareId, options);
    options.onStatus?.(status.status);
    if (status.status === "approved") return status;
    if (status.status === "failed") throw new SignerLinkFailedError(status.error);
    if (now() + intervalMs > deadline) throw new SignerLinkFailedError("timeout");
    await sleep(intervalMs, options.signal);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// FID resolution (public Hypersnap read — no API key)
// ---------------------------------------------------------------------------

/**
 * Accept an FID, `@username` or `username` and resolve it to an FID via the
 * public Hypersnap node (`/v2/farcaster/user/by-username`, unauthenticated).
 */
export async function resolveFid(
  query: string,
  options: { hypersnapUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<number> {
  const trimmed = query.trim().replace(/^@/, "");
  if (!trimmed) throw new FarcasterUserNotFoundError(query);
  if (/^\d+$/.test(trimmed)) {
    const fid = Number(trimmed);
    if (!Number.isSafeInteger(fid) || fid <= 0) {
      throw new FarcasterUserNotFoundError(query);
    }
    return fid;
  }
  if (!/^[a-z0-9][a-z0-9.-]{0,63}$/i.test(trimmed)) {
    throw new FarcasterUserNotFoundError(query);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.hypersnapUrl ?? HYPERSNAP_HTTP_URL}/v2/farcaster/user/by-username?username=${encodeURIComponent(trimmed.toLowerCase())}`;
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (response.status === 404) throw new FarcasterUserNotFoundError(query);
  if (!response.ok) throw new AuthRequestError(response.status, "lookup_failed");
  const body = (await response.json()) as { user?: { fid?: unknown } };
  const fid = body.user?.fid;
  if (typeof fid !== "number" || !Number.isSafeInteger(fid) || fid <= 0) {
    throw new FarcasterUserNotFoundError(query);
  }
  return fid;
}

/**
 * Look up an FID's IdRegistry custody address via the public Hypersnap node
 * (`/v2/farcaster/user/bulk`, unauthenticated). Custody is public data.
 */
export async function fetchCustodyAddress(
  fid: number,
  options: { hypersnapUrl?: string; fetchImpl?: FetchLike } = {},
): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${options.hypersnapUrl ?? HYPERSNAP_HTTP_URL}/v2/farcaster/user/bulk?fids=${fid}`;
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new AuthRequestError(response.status, "lookup_failed");
  const body = (await response.json()) as { users?: { custody_address?: unknown }[] };
  const custody = body.users?.[0]?.custody_address;
  if (typeof custody !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(custody)) {
    throw new FarcasterUserNotFoundError(String(fid));
  }
  return custody;
}
