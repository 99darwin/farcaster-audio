/**
 * Protocol Auth inside a Farcaster Mini App host.
 *
 * Flow:
 *   1. `protocolAuth.getToken()` from `@farcasterorg/miniapp-sdk` asks the
 *      host wallet to sign an `hqa1` token (EIP-4361 message naming the
 *      host's user FID). No hosted auth server is involved; do not use the
 *      SDK's `quickAuth`, which still depends on one.
 *   2. `POST /v1/auth/miniapp-quickauth` verifies the token against
 *      on-chain state (custody or KeyRegistry auth address) and returns a
 *      short-lived Juke session JWT that never outlives the token.
 *
 * `/v1/auth/protocol` is not used here: it requires a nonce minted by
 * `/v1/auth/siwf/nonce`, while host-signed tokens carry a client nonce.
 *
 * Returns a discriminated union so callers can react to specific failure
 * modes (user dismissal vs network error vs server verify failure).
 */

import { sdk as miniAppSdk } from "@farcasterorg/miniapp-sdk";
import { parseJwtExpiry } from "@/lib/auth/session";
import { canTrustMiniappHost } from "@/lib/miniapp-host-origin";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

if (
  typeof process !== "undefined" &&
  process.env.NODE_ENV !== "production" &&
  process.env.NODE_ENV !== "test" &&
  !process.env.NEXT_PUBLIC_API_BASE_URL
) {
  // Preview deploys must not throw, but a missing API base URL in dev is
  // almost always a mistake — surface it early so developers notice.
  // eslint-disable-next-line no-console
  console.warn(
    "[miniapp-auth] NEXT_PUBLIC_API_BASE_URL is unset; falling back to http://localhost:8000",
  );
}

export const MINIAPP_QUICKAUTH_PATH = "/v1/auth/miniapp-quickauth";

/**
 * Optimism. The backend pins Protocol Auth tokens to chain-id 10 (where the
 * Id/KeyRegistry live); see `lib/auth/protocolToken.ts`.
 */
const PROTOCOL_AUTH_CHAIN_ID_HEX = "0xa";

// Conservative token cache: refresh 60 seconds before `exp` to avoid
// race conditions near expiry. If exp can't be parsed, we default to
// 10 minutes (MIN_LIFETIME_MS).
const MIN_LIFETIME_MS = 10 * 60 * 1000;
const EXPIRY_SAFETY_MS = 60 * 1000;

// Plain desktop browsers outside a Farcaster host will never answer the
// host bridge. The SDK's detection short-circuits top-level windows; the
// timeout guards a host check that itself stalls.
const MINIAPP_CHECK_TIMEOUT_MS = 3000;
// Once inside a host, `getToken` waits on the user's wallet approval, which
// can legitimately take a while. This only guards a wedged bridge; hitting
// it is a `timeout` (try again), never "not in a Mini App".
export const PROTOCOL_AUTH_TIMEOUT_MS = 2 * 60 * 1000;
const PROTOCOL_AUTH_TIMEOUT_MESSAGE = "protocol_auth_timeout";

/**
 * Lifetime of the host-signed `hqa1` token. The backend caps tokens at one
 * hour and mints the session JWT with `exp <= token expiry`, so this is
 * also the Mini App session length.
 */
export const MINIAPP_TOKEN_TTL_SECONDS = 60 * 60;

interface CachedAuth {
  token: string;
  fid: number;
  expiresAt: number;
}

let cached: CachedAuth | null = null;

export type MiniappAuthError =
  | "user_cancelled"
  | "network"
  | "verify_failed"
  | "invalid_response"
  | "timeout"
  | "not_in_miniapp";

export interface MiniappAuthOptions {
  /**
   * Sign a new token even if the SDK still holds one. Needed for renewal:
   * the session JWT never outlives the token, so reusing the SDK's cached
   * token would mint a session that expires when the old one does.
   */
  force?: boolean;
}

export type MiniappAuthResult =
  | { ok: true; token: string; fid: number; expiresAt: number }
  | { ok: false; reason: MiniappAuthError };

type HostProvider = NonNullable<
  Awaited<ReturnType<typeof miniAppSdk.wallet.getEthereumProvider>>
>;

export async function isInMiniappHost(): Promise<boolean> {
  // A frame whose parent isn't a known Farcaster client may be a fake host
  // trying to sign the visitor in as someone else (`lib/miniapp-host-origin.ts`).
  if (!canTrustMiniappHost()) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), MINIAPP_CHECK_TIMEOUT_MS);
    });
    return await Promise.race([miniAppSdk.isInMiniApp(), timeout]);
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The SDK writes the wallet's *current* chain into the SIWE message, but
 * the backend only accepts chain-id 10. An EOA `personal_sign` doesn't
 * depend on the chain, so report Optimism to the token builder and pass
 * every other request through to the host wallet untouched.
 */
export function withProtocolAuthChainId(provider: HostProvider): HostProvider {
  const request = ((args: { method: string; params?: unknown }) =>
    args.method === "eth_chainId"
      ? Promise.resolve(PROTOCOL_AUTH_CHAIN_ID_HEX)
      : provider.request(args as Parameters<HostProvider["request"]>[0])) as
    HostProvider["request"];
  return new Proxy(provider, {
    get(target, property) {
      if (property === "request") return request;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function isUserRejection(err: unknown): boolean {
  const name = (err as { name?: unknown })?.name;
  const code = (err as { code?: unknown })?.code;
  // EIP-1193 4001 / ox `UserRejectedRequestError` / miniapp `RejectedByUser`.
  return (
    code === 4001 ||
    (typeof name === "string" && (name.includes("Rejected") || name.includes("UserRejected")))
  );
}

async function acquireProtocolToken({
  force = false,
}: MiniappAuthOptions): Promise<
  { ok: true; token: string } | { ok: false; reason: MiniappAuthError }
> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = await miniAppSdk.wallet.getEthereumProvider();
    // A host without a wallet can't sign a Protocol Auth token.
    if (!provider) return { ok: false, reason: "not_in_miniapp" };

    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(PROTOCOL_AUTH_TIMEOUT_MESSAGE)),
        PROTOCOL_AUTH_TIMEOUT_MS,
      );
    });
    // `fid` is omitted so the SDK takes it from the host's user context.
    const { token } = await Promise.race([
      miniAppSdk.protocolAuth.getToken({
        provider: withProtocolAuthChainId(provider),
        force,
        expiresIn: MINIAPP_TOKEN_TTL_SECONDS,
      }),
      timeout,
    ]);
    return { ok: true, token };
  } catch (err) {
    if (isUserRejection(err)) return { ok: false, reason: "user_cancelled" };
    if ((err as { message?: unknown })?.message === PROTOCOL_AUTH_TIMEOUT_MESSAGE) {
      return { ok: false, reason: "timeout" };
    }
    return { ok: false, reason: "network" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Exchange an `hqa1` token for a Juke session JWT. Exported so callers that
 * already hold a token (e.g. the embed SDK's tests) share one parser.
 */
export async function exchangeProtocolToken(
  protocolToken: string,
  options: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
): Promise<MiniappAuthResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const verifyUrl = `${options.baseUrl ?? API_BASE_URL}${MINIAPP_QUICKAUTH_PATH}`;
  let resp: Response;
  try {
    resp = await fetchImpl(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: protocolToken }),
    });
  } catch {
    return { ok: false, reason: "network" };
  }

  // Defense in depth: confirm the response actually came from the same
  // origin we posted to. Rules out a transparent proxy rewriting `resp.url`.
  // An empty `resp.url` (some polyfills/mocks) is not a redirect.
  if (resp.url) {
    try {
      if (new URL(resp.url).origin !== new URL(verifyUrl).origin) {
        return { ok: false, reason: "invalid_response" };
      }
    } catch {
      return { ok: false, reason: "invalid_response" };
    }
  }

  if (!resp.ok) {
    // 401 means the token didn't verify (wrong domain/chain, or the host
    // wallet isn't the FID's custody or a linked auth address). Surface it
    // as a distinct, non-retried error.
    return { ok: false, reason: resp.status >= 500 ? "network" : "verify_failed" };
  }

  let body: unknown;
  try {
    body = await resp.json();
  } catch {
    return { ok: false, reason: "invalid_response" };
  }

  if (typeof body !== "object" || body === null) {
    return { ok: false, reason: "invalid_response" };
  }
  const { token, fid } = body as { token?: unknown; fid?: unknown };
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "invalid_response" };
  }
  if (typeof fid !== "number" || !Number.isSafeInteger(fid) || fid <= 0) {
    return { ok: false, reason: "invalid_response" };
  }

  const expiresAt = parseJwtExpiry(token) ?? Date.now() + MIN_LIFETIME_MS;
  return { ok: true, token, fid, expiresAt };
}

/**
 * Full Mini App sign-in: detect the host, sign an `hqa1` token with the
 * host wallet, exchange it for a Juke session JWT, and cache the result.
 */
export async function authenticateMiniapp(
  options: MiniappAuthOptions = {},
): Promise<MiniappAuthResult> {
  // Bail out early in plain browsers — there is no host wallet to sign.
  if (!(await isInMiniappHost())) {
    return { ok: false, reason: "not_in_miniapp" };
  }

  const acquired = await acquireProtocolToken(options);
  if (!acquired.ok) return acquired;

  const result = await exchangeProtocolToken(acquired.token);
  if (result.ok) {
    cached = { token: result.token, fid: result.fid, expiresAt: result.expiresAt };
  }
  return result;
}

/**
 * Returns a cached auth result if the JWT is still comfortably valid,
 * otherwise runs the full flow. Call sites should prefer this over
 * `authenticateMiniapp()` unless they specifically want to force re-auth.
 */
export async function getCachedMiniappAuth(): Promise<MiniappAuthResult> {
  if (cached && Date.now() + EXPIRY_SAFETY_MS < cached.expiresAt) {
    return { ok: true, ...cached };
  }
  return authenticateMiniapp();
}

/**
 * Clear the cached token. Call after a 401 from the backend or on sign-out.
 */
export function clearCachedMiniappAuth(): void {
  cached = null;
}
