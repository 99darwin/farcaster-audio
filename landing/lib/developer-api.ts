"use client";

export const DEVELOPER_API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://your-api-host.example.com";

const EXPIRY_SAFETY_MS = 60 * 1000;

export type SiwnExpectation = { nonce: string; source: Window | null };

export type StartDeveloperSiwnResult = {
  authorizationUrl: string;
  popup: Window | null;
  nonce: string;
};

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

export type SiwnPayload = {
  fid: number | string;
  signer_uuid: string;
  nonce: string;
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

  async startSiwn(
    options?: { openPopup?: boolean },
  ): Promise<StartDeveloperSiwnResult> {
    const res = await fetch(`${DEVELOPER_API_BASE_URL}/v1/auth/neynar-auth-url`, {
      cache: "no-store",
    });
    // parseJsonResponse runs toCamelCase on the body, so the server's
    // {"authorization_url": "..."} arrives here as {authorizationUrl: "..."}.
    // The type reflects post-normalization shape.
    const body = await parseJsonResponse<{ authorizationUrl: string }>(
      res,
      "Could not start sign in",
    );
    if (!body?.authorizationUrl) {
      throw new DeveloperApiError("Could not start sign in", 500);
    }
    const nonce = generateSiwnNonce();
    const authorizationUrl = appendSiwnCallback(body.authorizationUrl, nonce);

    const popup =
      options?.openPopup === false
        ? null
        : window.open(
            authorizationUrl,
            "_blank",
            "popup=yes,width=430,height=720",
          );

    return { authorizationUrl, popup, nonce };
  }

  async completeSiwn(payload: SiwnPayload): Promise<DeveloperSession> {
    const fid =
      typeof payload.fid === "string" ? Number.parseInt(payload.fid, 10) : payload.fid;
    if (!Number.isFinite(fid) || fid <= 0 || !payload.signer_uuid) {
      throw new Error("Invalid sign-in response");
    }

    const res = await fetch(`${DEVELOPER_API_BASE_URL}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // use_cookie:true tells the API to deliver the refresh token via an
      // HttpOnly cookie scoped to /v1/auth instead of returning it in the
      // response body. credentials:"include" is required for cross-origin
      // (juke.audio → your-api-host.example.com) to send/receive cookies.
      credentials: "include",
      body: JSON.stringify({
        fid,
        signer_uuid: payload.signer_uuid,
        use_cookie: true,
      }),
    });
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

// Neynar's web SIWN flow posts the auth payload to `window.opener` directly
// from the popup running on `app.neynar.com` — it does NOT redirect to the
// `deeplink_url` we pass (that's for mobile/WebView flows). So we accept
// messages from Neynar's origin AS LONG AS the message came from the
// specific popup window we opened (event.source binding below).
//
// Security model:
//   1. event.source === expected.source — the message must come from the
//      window we called window.open() on. An attacker on app.neynar.com
//      can't be event.source unless they're hosted INSIDE the auth URL
//      we constructed, which requires compromising Neynar's auth page.
//   2. event.origin is on a small allowlist — sanity tripwire only.
//   3. Payload shape is valid.
//   4. Nonce check is enforced ONLY when the message came from our own
//      origin (the /embed/auth/callback page, used by mobile/WebView).
//      Neynar's direct postMessage doesn't propagate our URL params.
const TRUSTED_SIWN_ORIGINS = new Set([
  "https://app.neynar.com",
  "https://farcaster.xyz",
  "https://client.farcaster.xyz",
]);

export function isTrustedDeveloperSiwnMessage(
  event: MessageEvent,
  expected: SiwnExpectation,
): boolean {
  if (typeof window === "undefined") return false;
  // event.source binding is the primary defense — without a popup
  // reference we can't safely accept any message.
  if (!expected.source || event.source !== expected.source) return false;
  const ownOrigin = window.location.origin;
  const isOwnOrigin = event.origin === ownOrigin;
  if (!isOwnOrigin && !TRUSTED_SIWN_ORIGINS.has(event.origin)) return false;
  const payload = parseDeveloperSiwnPayload(event.data);
  if (!payload) return false;
  // Nonce binding only applies on the own-origin callback path. Neynar's
  // direct postMessage doesn't include URL params we set on deeplink_url.
  if (isOwnOrigin && payload.nonce !== expected.nonce) return false;
  return true;
}

export function parseDeveloperSiwnPayload(data: unknown): SiwnPayload | null {
  let payload = data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  if (typeof payload !== "object" || payload === null) return null;

  const candidate = payload as Partial<SiwnPayload> & {
    is_authenticated?: boolean;
    nonce?: unknown;
  };
  if (!candidate.signer_uuid || candidate.fid === undefined) return null;
  if (candidate.is_authenticated === false) return null;
  // Nonce is optional in the payload — Neynar's direct postMessage path
  // does not include it; the own-origin callback path does and we
  // validate it in `isTrustedDeveloperSiwnMessage`.
  return {
    fid: candidate.fid,
    signer_uuid: candidate.signer_uuid,
    nonce:
      typeof candidate.nonce === "string" && candidate.nonce
        ? candidate.nonce
        : "",
  };
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

function appendSiwnCallback(rawUrl: string, nonce: string): string {
  const url = new URL(rawUrl);
  if (typeof window !== "undefined") {
    const callback = new URL("/embed/auth/callback", window.location.origin);
    callback.searchParams.set("nonce", nonce);
    url.searchParams.set("deeplink_url", callback.toString());
  }
  return url.toString();
}

function generateSiwnNonce(): string {
  return crypto.randomUUID();
}

function normalizeLogin(body: LoginResponse): DeveloperSession {
  // refresh_token is intentionally not stored on the client — the dashboard
  // uses cookie-based refresh (see completeSiwn) so the refresh token never
  // touches JS-accessible storage.
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
