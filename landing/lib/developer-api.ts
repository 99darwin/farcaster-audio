"use client";

import { createAppClient, viemConnector } from "@farcaster/auth-client";

export const DEVELOPER_API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000";

const EXPIRY_SAFETY_MS = 60 * 1000;

// Sign In With Farcaster — EIP-4361 / SIWE. The signed message
// includes the requesting `domain`, which the Farcaster client
// displays to the user at approval time. That structurally closes
// the QR phishing chain that the old `createSigner` flow couldn't
// defend against.
export type StartSiwfFlowResult = {
  channelToken: string;
  url: string;
};

export type SiwfApproved = {
  message: string;
  signature: string;
  fid: number;
};

export const SIWF_POLL_INTERVAL_MS = 2000;
// AuthKit relay times its channels out at 10 minutes — match.
const SIWF_TIMEOUT_MS = 10 * 60 * 1000;

const siwfAppClient = createAppClient({
  relay: "https://relay.farcaster.xyz",
  ethereum: viemConnector(),
});

let memorySession: DeveloperSession | null = null;

export type DeveloperStatus = "none" | "pending" | "approved" | "suspended";

export type DeveloperSession = {
  jwt: string;
  expiresAt: string;
  fid: number;
};

export type DeveloperProfile = {
  fid: number;
  username?: string | null;
  displayName?: string | null;
  status: DeveloperStatus;
  suspensionReason?: string | null;
  reviewedAt?: string | null;
  application?: DeveloperApplication | null;
};

export type DeveloperApplication = {
  id?: string | number | null;
  fid?: number | null;
  projectName: string;
  websiteUrl?: string | null;
  useCase: string;
  status?: DeveloperStatus;
  createdAt?: string | null;
  updatedAt?: string | null;
  reviewedAt?: string | null;
};

export type DeveloperAccessUser = {
  fid: number;
  username?: string | null;
  displayName?: string | null;
  developerAccessStatus: DeveloperStatus;
  application?: DeveloperApplication | null;
};

export type DeveloperApp = {
  id: string;
  ownerFid?: number;
  name: string;
  description?: string | null;
  websiteUrl?: string | null;
  allowedOrigins: string[];
  status?: string;
  createdAt: string;
  updatedAt?: string | null;
  keys: DeveloperApiKey[];
};

export type DeveloperApiKey = {
  appId: string;
  keyId: string;
  name: string;
  publicKey?: string | null;
  status: "active" | "revoked";
  createdAt: string;
  revealExpiresAt?: string | null;
  revealedAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  rotatedFromKeyId?: string | null;
};

export type CreateDeveloperAppInput = {
  name: string;
  description?: string;
  websiteUrl?: string;
  allowedOrigins?: string[];
};

export type CreateDeveloperKeyInput = {
  name: string;
};

export type CreateDeveloperKeyResponse = {
  key: DeveloperApiKey;
  secret: string;
  revealToken?: string | null;
};

export type DeveloperDashboardResponse = {
  profile: DeveloperProfile;
  apps: DeveloperApp[];
};

export type DeveloperApplicationInput = {
  projectName: string;
  websiteUrl?: string;
  useCase: string;
};

// Post-normalization shape — `parseJsonResponse` runs `toCamelCase`, so the
// server's snake_case fields (`refresh_token`, `expires_at`) arrive here as
// camelCase. The legacy `refresh_token` is optional because the dashboard
// uses cookie-based refresh and the body omits it.
type LoginResponse = {
  jwt: string;
  refreshToken?: string | null;
  expiresAt: string;
  user: { fid: number };
};

type DeveloperStatusResponse = {
  developerAccessStatus: DeveloperStatus;
  fid?: number;
  username?: string | null;
  displayName?: string | null;
  suspensionReason?: string | null;
  reviewedAt?: string | null;
  application?: DeveloperApplication | null;
};

type DeveloperAppListResponse = {
  apps: Omit<DeveloperApp, "keys">[];
};

type DeveloperKeyListResponse = {
  keys: DeveloperApiKeyResponse[];
};

type DeveloperApiKeyResponse = {
  appId: string;
  keyId: string;
  name: string;
  publicKey?: string | null;
  secretKey?: string | null;
  revealToken?: string | null;
  revealExpiresAt?: string | null;
  revealedAt?: string | null;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  rotatedFromKeyId?: string | null;
  createdAt?: string | null;
};

type DeveloperKeyRevealResponse = {
  secretKey: string;
  revealExpiresAt?: string | null;
};

type DeveloperUserListResponse = {
  users: DeveloperAccessUser[];
};

export class DeveloperApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DeveloperApiError";
    this.status = status;
  }
}

/**
 * Thrown when the server requires a recent SIWN re-authentication for a
 * dangerous mutation (rotate / revoke / reveal / delete-app). The session
 * is NOT cleared — the user just needs to sign in again to lift the
 * step-up. UI surfaces this distinctly from "your session expired".
 */
export class ReauthRequiredError extends DeveloperApiError {
  constructor(message = "Sign in again to continue.") {
    super(message, 401);
    this.name = "ReauthRequiredError";
  }
}

const REAUTH_DETAIL_MATCH = /recent sign-in/i;

export class DeveloperApiClient {
  private session: DeveloperSession | null;

  constructor(session = memorySession) {
    this.session = session;
  }

  get currentSession(): DeveloperSession | null {
    return this.session;
  }

  /**
   * Sign In With Farcaster (SIWF) — EIP-4361 / SIWE.
   *
   * Why this and not the legacy `createSigner + registerSignedKey`
   * flow we shipped originally: SIWF binds the requesting `domain`
   * into the signed message, and the Farcaster client displays that
   * domain to the user at approval time. A victim scanning a QR
   * generated on `evil.com` sees `evil.com wants you to sign in`
   * rather than just the registered app name — structurally closes
   * the QR phishing chain.
   *
   * Flow:
   * 1. `startSiwfFlow()` fetches a server-issued nonce from
   *    `/v1/auth/siwf/nonce` and asks the Farcaster auth relay to
   *    open a channel. Returns `{channelToken, url}` — the url is a
   *    `farcaster://connect?channelToken=...` deeplink to render as
   *    a QR or tap-to-open on mobile.
   * 2. `pollSiwfStatus(channelToken)` waits via the auth-client SDK
   *    until the user approves and the relay returns the signed SIWE
   *    message + signature.
   * 3. `completeSiwfLogin({message, signature})` POSTs to our backend
   *    which cryptographically verifies the signature, confirms the
   *    domain + nonce, resolves the custody address to a FID via
   *    Neynar, and mints a Juke JWT.
   */
  async startSiwfFlow(): Promise<StartSiwfFlowResult> {
    // Server-issued nonce — gives us replay protection and lets us
    // bound a single sign-in attempt to a short window.
    const nonceRes = await fetch(
      `${DEVELOPER_API_BASE_URL}/v1/auth/siwf/nonce`,
      { method: "POST" },
    );
    const nonceBody = await parseJsonResponse<{ nonce: string }>(
      nonceRes,
      "Could not start sign in",
    );
    if (!nonceBody?.nonce) {
      throw new DeveloperApiError("Could not start sign in", 500);
    }

    // `acceptAuthAddress: false` forces the Farcaster client to sign
    // with the custody key. The default flipped to `true` in
    // @farcaster/auth-client 0.7.0, but our backend resolves the
    // recovered signer via Neynar's bulk-by-address endpoint, which
    // only indexes custody + verified-wallet addresses — not
    // auth-addresses (FIP #225, key type 2). Accepting an auth-address
    // signature would 401 the login post-verify. Also empirically
    // unblocks desktop-QR-from-mobile-app sign-ins for users whose
    // FID already has an auth-address registered.
    const channel = await siwfAppClient.createChannel({
      siweUri: `${window.location.origin}/developers`,
      domain: window.location.hostname,
      nonce: nonceBody.nonce,
      acceptAuthAddress: false,
    });

    if (!channel.data?.channelToken || !channel.data?.url) {
      throw new DeveloperApiError("Could not start sign in", 502);
    }
    return {
      channelToken: channel.data.channelToken,
      url: channel.data.url,
    };
  }

  /**
   * Wait for the Farcaster relay to report completion. Resolves to
   * the SIWE message + signature when the user approves. Callers
   * pass an AbortSignal so the polling stops on user cancel /
   * component unmount.
   */
  async pollSiwfStatus(
    channelToken: string,
    options?: { signal?: AbortSignal },
  ): Promise<SiwfApproved> {
    if (options?.signal?.aborted) {
      throw new DeveloperApiError("Sign-in cancelled", 0);
    }
    // The auth-client SDK does the polling; we just race against
    // the abort signal so cancel happens quickly. The SDK exposes
    // an `onResponse` callback we use to bail out promptly when the
    // user cancels (rather than waiting for the next status poll).
    let aborted = false;
    const abortHandler = () => {
      aborted = true;
    };
    options?.signal?.addEventListener("abort", abortHandler);
    try {
      const result = await siwfAppClient.watchStatus({
        channelToken,
        timeout: SIWF_TIMEOUT_MS,
        interval: SIWF_POLL_INTERVAL_MS,
        onResponse: () => {
          if (aborted) throw new DeveloperApiError("Sign-in cancelled", 0);
        },
      });
      if (aborted) {
        throw new DeveloperApiError("Sign-in cancelled", 0);
      }
      const data = result.data;
      if (data.state !== "completed") {
        throw new DeveloperApiError("Sign-in did not complete", 408);
      }
      if (!data.message || !data.signature || !data.fid) {
        throw new DeveloperApiError("Incomplete SIWF response", 502);
      }
      return {
        message: data.message,
        signature: data.signature,
        fid: data.fid,
      };
    } finally {
      options?.signal?.removeEventListener("abort", abortHandler);
    }
  }

  /** Finish SIWF login. Submits the signed SIWE message to the
   *  backend, which verifies the signature + resolves fid via Neynar,
   *  and returns a Juke session. Sets the HttpOnly refresh cookie. */
  async completeSiwfLogin(
    payload: { message: string; signature: string },
  ): Promise<DeveloperSession> {
    if (!payload.message || !payload.signature) {
      throw new Error("Invalid sign-in response");
    }
    const res = await fetch(
      `${DEVELOPER_API_BASE_URL}/v1/auth/siwf/login`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          message: payload.message,
          signature: payload.signature,
          use_cookie: true,
        }),
      },
    );
    const body = await parseJsonResponse<LoginResponse>(
      res,
      "Could not complete sign in",
    );
    this.session = normalizeLogin(body);
    memorySession = this.session;
    return this.session;
  }

  signOut(): void {
    // Fire-and-forget: ask the API to clear the refresh cookie and revoke
    // the token in Redis. We don't await — clearing local state happens
    // immediately so the UI never blocks on the network.
    try {
      void fetch(`${DEVELOPER_API_BASE_URL}/v1/auth/logout`, {
        method: "POST",
        credentials: "include",
      }).catch(() => {});
    } catch {
      // never block sign-out on network errors
    }
    this.session = null;
    memorySession = null;
  }

  async getDashboard(): Promise<DeveloperDashboardResponse> {
    const status = await this.request<DeveloperStatusResponse>("/v1/developer/status");
    const profile: DeveloperProfile = {
      fid: status.fid ?? this.session?.fid ?? 0,
      username: status.username,
      displayName: status.displayName,
      status: status.developerAccessStatus,
      suspensionReason: status.suspensionReason,
      reviewedAt: status.reviewedAt,
      application: status.application,
    };

    if (status.developerAccessStatus !== "approved") {
      return { profile, apps: [] };
    }

    const appList = await this.request<DeveloperAppListResponse>("/v1/developer/apps");
    const apps = await Promise.all(
      appList.apps.map(async (app) => {
        const keys = await this.request<DeveloperKeyListResponse>(
          `/v1/developer/apps/${encodeURIComponent(app.id)}/keys`,
        );
        return {
          ...normalizeApp(app),
          keys: keys.keys.map(normalizeKey),
        };
      }),
    );
    return { profile, apps };
  }

  async submitApplication(
    input: DeveloperApplicationInput,
  ): Promise<DeveloperDashboardResponse> {
    await this.request<DeveloperStatusResponse>("/v1/developer/application", {
      method: "POST",
      body: JSON.stringify(toSnakeCaseApplication(input)),
    });
    return this.getDashboard();
  }

  async createApp(input: CreateDeveloperAppInput): Promise<DeveloperApp> {
    const app = await this.request<Omit<DeveloperApp, "keys">>("/v1/developer/apps", {
      method: "POST",
      body: JSON.stringify(toSnakeCaseApp(input)),
    });
    return { ...normalizeApp(app), keys: [] };
  }

  async createKey(
    appId: string,
    input: CreateDeveloperKeyInput,
  ): Promise<CreateDeveloperKeyResponse> {
    const key = await this.request<DeveloperApiKeyResponse>(
      `/v1/developer/apps/${encodeURIComponent(appId)}/keys`,
      {
        method: "POST",
        body: JSON.stringify({ name: input.name }),
      },
    );
    return {
      key: normalizeKey(key),
      secret: key.secretKey ?? "",
      revealToken: key.revealToken,
    };
  }

  async rotateKey(appId: string, keyId: string): Promise<CreateDeveloperKeyResponse> {
    const key = await this.request<DeveloperApiKeyResponse>(
      `/v1/developer/apps/${encodeURIComponent(appId)}/keys/${encodeURIComponent(keyId)}/rotate`,
      {
        method: "POST",
        body: JSON.stringify({ name: "Rotated server key" }),
      },
    );
    return {
      key: normalizeKey(key),
      secret: key.secretKey ?? "",
      revealToken: key.revealToken,
    };
  }

  async revokeKey(appId: string, keyId: string): Promise<DeveloperApiKey> {
    const response = await this.request<DeveloperApiKeyResponse | { status: string }>(
      `/v1/developer/apps/${encodeURIComponent(appId)}/keys/${encodeURIComponent(keyId)}/revoke`,
      { method: "POST" },
    );
    if ("keyId" in response) return normalizeKey(response);
    return {
      appId,
      keyId,
      name: "Revoked key",
      status: "revoked",
      createdAt: new Date().toISOString(),
      revokedAt: new Date().toISOString(),
    };
  }

  async revealKey(
    appId: string,
    keyId: string,
    revealToken: string,
  ): Promise<{ secret: string; revealExpiresAt?: string | null }> {
    const response = await this.request<DeveloperKeyRevealResponse>(
      `/v1/developer/apps/${encodeURIComponent(appId)}/keys/${encodeURIComponent(keyId)}/reveal`,
      {
        method: "POST",
        body: JSON.stringify({ reveal_token: revealToken }),
      },
    );
    return {
      secret: response.secretKey,
      revealExpiresAt: response.revealExpiresAt,
    };
  }

  async listDeveloperAccess(statusFilter?: DeveloperStatus): Promise<DeveloperAccessUser[]> {
    const query = statusFilter
      ? `?status_filter=${encodeURIComponent(statusFilter)}`
      : "";
    const response = await this.request<DeveloperUserListResponse>(
      `/v1/developer/admin/access${query}`,
    );
    return response.users;
  }

  async updateDeveloperAccess(
    fid: number,
    status: DeveloperStatus,
  ): Promise<DeveloperAccessUser> {
    return this.request<DeveloperAccessUser>(
      `/v1/developer/admin/access/${encodeURIComponent(String(fid))}`,
      {
        method: "POST",
        body: JSON.stringify({ status }),
      },
    );
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const session = await this.getFreshSession();
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${session.jwt}`);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const res = await fetch(`${DEVELOPER_API_BASE_URL}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });

    if (res.status === 401) {
      // Distinguish "session expired" (sign-out) from "step-up required"
      // (keep session; user just needs to SIWN again). The backend signals
      // step-up via the detail string "Recent sign-in required." and
      // WWW-Authenticate: ReAuth. Peek at the body without consuming it
      // for the success path.
      const detail = await peekErrorDetail(res);
      const wwwAuth = res.headers.get("www-authenticate") || "";
      if (
        (detail && REAUTH_DETAIL_MATCH.test(detail)) ||
        /reauth/i.test(wwwAuth)
      ) {
        throw new ReauthRequiredError(detail || undefined);
      }
      this.signOut();
      throw new DeveloperApiError(
        detail || "Juke developer API request failed",
        401,
      );
    }

    return parseJsonResponse<T>(res, "Juke developer API request failed");
  }

  private async getFreshSession(): Promise<DeveloperSession> {
    if (!this.session) throw new DeveloperApiError("Sign in required", 401);

    const expiresAt = new Date(this.session.expiresAt).getTime();
    if (Number.isFinite(expiresAt) && Date.now() + EXPIRY_SAFETY_MS < expiresAt) {
      return this.session;
    }

    // The refresh token lives in the HttpOnly `juke_refresh` cookie, set by
    // /v1/auth/login when use_cookie:true. The body is intentionally empty
    // — credentials:"include" carries the cookie cross-origin.
    const res = await fetch(`${DEVELOPER_API_BASE_URL}/v1/auth/refresh`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.session.jwt}`,
      },
      body: JSON.stringify({}),
    });
    const body = await parseJsonResponse<LoginResponse>(
      res,
      "Could not refresh sign in",
    );
    this.session = normalizeLogin(body);
    memorySession = this.session;
    return this.session;
  }
}

export function createDeveloperApiClient(): DeveloperApiClient {
  return new DeveloperApiClient();
}

export function maskDeveloperKey(key: DeveloperApiKey): string {
  return `jk_sec_live_${key.keyId}_${"*".repeat(20)}`;
}

function normalizeKey(key: DeveloperApiKeyResponse): DeveloperApiKey {
  return {
    appId: key.appId,
    keyId: key.keyId,
    name: key.name,
    publicKey: key.publicKey,
    status: key.revokedAt ? "revoked" : "active",
    createdAt: key.createdAt ?? new Date().toISOString(),
    revealExpiresAt: key.revealExpiresAt,
    revealedAt: key.revealedAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    rotatedFromKeyId: key.rotatedFromKeyId,
  };
}

function normalizeApp(app: Omit<DeveloperApp, "keys">): Omit<DeveloperApp, "keys"> {
  return {
    ...app,
    websiteUrl: app.websiteUrl ?? null,
    allowedOrigins: app.allowedOrigins ?? [],
  };
}

function normalizeLogin(body: LoginResponse): DeveloperSession {
  // refresh_token is intentionally not stored on the client — the dashboard
  // uses cookie-based refresh (see completeSiwfLogin) so the refresh
  // token never touches JS-accessible storage.
  return {
    jwt: body.jwt,
    expiresAt: body.expiresAt,
    fid: body.user.fid,
  };
}

async function peekErrorDetail(res: Response): Promise<string | null> {
  // res.json() consumes the body; only call this on error paths where the
  // caller is about to throw anyway. Returns null if the body isn't a
  // FastAPI-shaped { detail: string } error.
  try {
    const body = (await res.clone().json()) as { detail?: unknown };
    if (typeof body?.detail === "string") return body.detail;
  } catch {
    // non-JSON body or already-consumed; treat as no detail
  }
  return null;
}

async function parseJsonResponse<T>(res: Response, fallback: string): Promise<T> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {}

  if (!res.ok) {
    const detail =
      typeof body === "object" && body !== null && "detail" in body
        ? String((body as { detail: unknown }).detail)
        : fallback;
    throw new DeveloperApiError(detail, res.status);
  }

  return normalizeResponse<T>(body);
}

function normalizeResponse<T>(body: unknown): T {
  return toCamelCase(body) as T;
}

function toSnakeCaseApplication(input: DeveloperApplicationInput) {
  return {
    project_name: input.projectName,
    website_url: input.websiteUrl || undefined,
    use_case: input.useCase,
  };
}

function toSnakeCaseApp(input: CreateDeveloperAppInput) {
  return {
    name: input.name,
    description: input.description || undefined,
    website_url: input.websiteUrl || undefined,
    allowed_origins: input.allowedOrigins ?? [],
  };
}

function toCamelCase(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamelCase);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      toCamelCase(entry),
    ]),
  );
}
