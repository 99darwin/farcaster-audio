"use client";

import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RoomOptions,
} from "livekit-client";
import type { LoginResponse } from "@/lib/api/types";
import {
  getBrowserAuthAddressStore,
  type AuthAddressStore,
} from "@/lib/auth/authAddressStore";
import { signInReturningBrowser } from "@/lib/auth/webSignIn";
import {
  EMBED_AUTH_OPTIONS,
  openEmbedSignInPopup,
} from "@/lib/embed-sign-in-popup";
import {
  authenticateMiniapp,
  clearCachedMiniappAuth,
  getCachedMiniappAuth,
  type MiniappAuthError,
} from "@/lib/miniapp-auth";

// Re-exported so SDK callers can catch it from `signInWithAuthAddress`.
export { LinkRequiredError } from "@/lib/auth/protocolLogin";
export {
  EMBED_AUTH_OPTIONS,
  EmbedSignInPopupError,
} from "@/lib/embed-sign-in-popup";
import {
  API_BASE_URL,
  getSpaceDetail,
  type JoinSpaceResponse,
  type SpaceDetailResponse,
} from "@/lib/spaces";

/**
 * Where an embed session came from. Decides how it is renewed:
 * - `protocol` / `siwf`: `POST /v1/auth/refresh` with the body refresh token.
 * - `miniapp`: no refresh token; re-run Protocol Auth with the host wallet.
 * - `partner`: no refresh token; the partner re-mints server-side.
 */
export type JukeEmbedAuthSource = "protocol" | "miniapp" | "partner" | "siwf";

export type JukeEmbedAuthSession = {
  jwt: string;
  refreshToken: string;
  expiresAt: string;
  fid: number;
  source: JukeEmbedAuthSource;
};

type AuthSession = JukeEmbedAuthSession;

/** Refresh this long before the JWT expires. */
const SESSION_REFRESH_MARGIN_MS = 60_000;

/**
 * Why a Mini App sign-in failed, on {@link JukeEmbedAuthError.reason}. Only
 * `verify_failed` (the host wallet isn't linked to the FID) means another
 * sign-in method can help; `user_cancelled` should return quietly, and
 * `network` / `timeout` / `invalid_response` are worth retrying.
 */
export type JukeEmbedAuthFailure = Exclude<MiniappAuthError, "not_in_miniapp">;

const MINIAPP_AUTH_ERROR_MESSAGES: Record<JukeEmbedAuthFailure, string> = {
  user_cancelled: "Sign-in was cancelled.",
  network: "Couldn't reach Juke. Check your connection and try again.",
  verify_failed:
    "Your Farcaster app's wallet couldn't sign in for this account. Sign in with your Farcaster account instead.",
  invalid_response: "Sign-in failed. Try again.",
  timeout: "Your wallet didn't respond. Try again.",
};

export type TokenRefreshResponse = {
  livekit_token: string;
  expires_at: string;
};

export type RaiseHandResponse = {
  hand_raised: boolean;
  queue_position: number | null;
};

export type ConnectAudioOptions = {
  onTrackSubscribed?: (track: RemoteTrack, element: HTMLMediaElement) => void;
  onTrackUnsubscribed?: (track: RemoteTrack) => void;
  onActiveSpeakersChanged?: (identities: string[]) => void;
  onDisconnected?: () => void;
};

const ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: true,
  dynacast: false,
};

const PARTICIPANT_ROLES_WITH_MIC = new Set(["host", "co_host", "speaker"]);

export class JukeEmbedAuthError extends Error {
  /** Set when a Mini App sign-in failed; absent for other auth errors. */
  readonly reason?: JukeEmbedAuthFailure;

  constructor(message = "Sign in to participate", reason?: JukeEmbedAuthFailure) {
    super(message);
    this.name = "JukeEmbedAuthError";
    this.reason = reason;
  }
}

export class JukeEmbedSdk {
  private authSession: AuthSession | null = null;
  private activeRoom: Room | null = null;
  private activeSpaceId: string | null = null;
  private activeJoin: JoinSpaceResponse | null = null;

  /**
   * Adopt a partner-minted Juke JWT (issued by `POST /v1/developer/partner-tokens`).
   *
   * Used by the iframe when the embedding site has already authenticated
   * the visitor and passes a short-lived Juke JWT via `#token=...`
   * (or the deprecated `?token=...`) on the embed URL. fid and expiresAt come from the JWT claims. No refresh
   * token is issued for partner sessions; when the JWT expires the iframe
   * falls back to the regular Protocol Auth sign-in.
   *
   * @throws if the token is malformed or expired client-side. The backend
   *   re-verifies on every authed call, so a forged token still fails at
   *   join time — this check is a UX guard, not a security boundary.
   */
  adoptPartnerSession(token: string): AuthSession {
    const claims = decodePartnerJwtClaims(token);
    this.authSession = {
      jwt: token,
      refreshToken: "",
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      fid: claims.fid,
      source: "partner",
    };
    return this.authSession;
  }

  async getSpace(spaceId: string): Promise<SpaceDetailResponse | null> {
    return getSpaceDetail(spaceId);
  }

  async joinAnonymousListener(spaceId: string): Promise<JoinSpaceResponse> {
    const res = await fetch(
      `${API_BASE_URL}/v1/rooms/${encodeURIComponent(spaceId)}/anonymous-join`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    return parseJsonResponse<JoinSpaceResponse>(res, "Could not join space");
  }

  /**
   * Protocol Auth inside a Farcaster Mini App host: the host wallet signs an
   * `hqa1` token (`@farcasterorg/miniapp-sdk` `protocolAuth`) and
   * `POST /v1/auth/miniapp-quickauth` exchanges it for a Juke JWT. No auth
   * relay, no QR, no approval in another app.
   *
   * @param options.force sign a new host token instead of reusing a cached
   *   one (used for renewal).
   * @returns the session, or `null` when not running inside a Mini App host
   *   (or the host has no wallet) — fall back to {@link signInWithPopup}.
   * @throws {JukeEmbedAuthError} with `reason` set. Only `verify_failed`
   *   (the host wallet isn't the FID's custody or a linked auth address)
   *   should fall back to the web flow.
   */
  async signInWithMiniApp(options?: { force?: boolean }): Promise<AuthSession | null> {
    const force = options?.force ?? false;
    if (force) clearCachedMiniappAuth();
    const result = force
      ? await authenticateMiniapp({ force })
      : await getCachedMiniappAuth();
    if (!result.ok) {
      if (result.reason === "not_in_miniapp") return null;
      throw new JukeEmbedAuthError(
        MINIAPP_AUTH_ERROR_MESSAGES[result.reason],
        result.reason,
      );
    }
    this.authSession = {
      jwt: result.token,
      refreshToken: "",
      expiresAt: new Date(result.expiresAt).toISOString(),
      fid: result.fid,
      source: "miniapp",
    };
    return this.authSession;
  }

  /**
   * Web sign-in for a returning browser: this browser's stored auth address
   * (KeyRegistry keyType 2) signs an `hqa1` token and
   * `POST /v1/auth/protocol` mints the session. No phrase, no other app.
   *
   * @throws {LinkRequiredError} (from `@/lib/auth/protocolLogin`) when this
   *   browser has no linked key for `fid` — use {@link signInWithPopup}.
   */
  async signInWithAuthAddress(
    fid: number,
    options?: { store?: AuthAddressStore },
  ): Promise<AuthSession> {
    const response = await signInReturningBrowser(
      { fid, store: options?.store ?? getBrowserAuthAddressStore() },
      EMBED_AUTH_OPTIONS,
    );
    return this.adoptLoginResponse(response);
  }

  /**
   * Web sign-in in a first-party juke.audio popup: a browser already linked
   * on juke.audio signs in with its auth address; a new browser links once
   * with the recovery phrase — in the popup, never in the embed's frame.
   * Only the session comes back (via a same-origin `postMessage`).
   *
   * Works only when the SDK runs on the Juke origin (the hosted iframe);
   * the popup never posts to another origin. Call it synchronously from a
   * click handler so the browser doesn't block the popup.
   *
   * @throws {EmbedSignInPopupError} when the popup is blocked, closed, or
   *   `signal` aborts.
   */
  async signInWithPopup(options?: { signal?: AbortSignal }): Promise<AuthSession> {
    const response = await openEmbedSignInPopup({ signal: options?.signal });
    return this.adoptLoginResponse(response);
  }

  /**
   * Adopt a `LoginResponse` minted elsewhere with {@link EMBED_AUTH_OPTIONS}.
   */
  adoptLoginResponse(response: LoginResponse): AuthSession {
    return this.storeLoginResponse(response, "protocol");
  }

  /**
   * Exchange an already-signed Sign In With Farcaster message for a session.
   *
   * @deprecated The relay helpers that produced these credentials
   *   (`startSiwfFlow` / `pollSiwfStatus`) were removed with the move off
   *   Farcaster-hosted auth. Use {@link signInWithMiniApp} or the web
   *   auth-address flow. Kept only so existing callers still compile.
   */
  async completeSiwfLogin(
    payload: { message: string; signature: string },
  ): Promise<AuthSession> {
    if (!payload.message || !payload.signature) {
      throw new Error("Invalid sign-in response");
    }
    const res = await fetch(`${API_BASE_URL}/v1/auth/siwf/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: payload.message,
        signature: payload.signature,
        use_cookie: false,
      }),
    });
    const body = await parseJsonResponse<LoginResponse>(
      res,
      "Could not complete sign in",
    );
    return this.storeLoginResponse(body, "siwf");
  }

  async joinAuthenticated(spaceId: string): Promise<JoinSpaceResponse> {
    const session = await this.getFreshAuthSession();
    const res = await fetch(
      `${API_BASE_URL}/v1/rooms/${encodeURIComponent(spaceId)}/join`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.jwt}`,
        },
      },
    );
    const body = await parseJsonResponse<JoinSpaceResponse>(
      res,
      "Could not join as participant",
    );
    this.activeJoin = body;
    this.activeSpaceId = spaceId;
    return body;
  }

  async leaveSpace(spaceId?: string): Promise<void> {
    await this.disconnectAudio();
    this.activeJoin = null;
    const id = spaceId ?? this.activeSpaceId;
    this.activeSpaceId = null;

    if (!id || !this.authSession) return;
    const session = await this.getFreshAuthSession().catch(() => null);
    if (!session) return;

    await fetch(`${API_BASE_URL}/v1/rooms/${encodeURIComponent(id)}/leave`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.jwt}` },
    }).catch(() => {});
  }

  async refreshToken(spaceId?: string): Promise<TokenRefreshResponse> {
    const session = await this.getFreshAuthSession();
    const id = spaceId ?? this.activeSpaceId;
    if (!id) throw new Error("No active space");

    const res = await fetch(
      `${API_BASE_URL}/v1/rooms/${encodeURIComponent(id)}/token`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${session.jwt}` },
      },
    );
    return parseJsonResponse<TokenRefreshResponse>(
      res,
      "Could not refresh audio token",
    );
  }

  async sendReaction(key: string): Promise<void> {
    this.requireAuthenticated();
    if (!/^[a-z0-9_:+-]{1,32}$/i.test(key)) {
      throw new Error("Invalid reaction");
    }
    const room = this.requireConnectedRoom();
    const payload = new TextEncoder().encode(
      JSON.stringify({ type: "reaction", key }),
    );
    await room.localParticipant.publishData(payload, {
      topic: "reactions",
      reliable: false,
    });
  }

  async raiseHand(spaceId: string, raised: boolean): Promise<RaiseHandResponse> {
    const session = await this.getFreshAuthSession();
    const res = await fetch(
      `${API_BASE_URL}/v1/rooms/${encodeURIComponent(spaceId)}/raise-hand`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.jwt}`,
        },
        body: JSON.stringify({ raised }),
      },
    );
    return parseJsonResponse<RaiseHandResponse>(res, "Could not raise hand");
  }

  async connectAudio(
    join: JoinSpaceResponse,
    options?: ConnectAudioOptions,
  ): Promise<Room> {
    if (!supportsWebRtc()) {
      throw new Error("This browser cannot play live audio");
    }

    await this.disconnectAudio();

    const room = new Room({
      ...ROOM_OPTIONS,
      publishDefaults: { audioPreset: { maxBitrate: 48_000 } },
    });
    this.activeRoom = room;
    this.activeJoin = join;
    this.activeSpaceId = join.room.id;

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.setAttribute("playsinline", "true");
      element.dataset.jukeEmbedAudio = "true";
      element.style.display = "none";
      document.body.appendChild(element);
      options?.onTrackSubscribed?.(track, element);
    });

    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((element) => element.remove());
      options?.onTrackUnsubscribed?.(track);
    });

    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      options?.onActiveSpeakersChanged?.(speakers.map((speaker) => speaker.identity));
    });

    room.on(RoomEvent.Disconnected, () => {
      document
        .querySelectorAll("[data-juke-embed-audio='true']")
        .forEach((element) => element.remove());
      this.activeRoom = null;
      options?.onDisconnected?.();
    });

    await room.connect(join.livekit_ws_url, join.livekit_token, {
      autoSubscribe: true,
    });
    join.livekit_token = "";
    return room;
  }

  async enableMicrophone(enabled = true): Promise<void> {
    this.requireAuthenticated();
    const role = this.activeJoin?.role;
    if (!role || !PARTICIPANT_ROLES_WITH_MIC.has(role)) {
      throw new Error("A host must approve you before you can speak");
    }
    const room = this.requireConnectedRoom();
    await room.localParticipant.setMicrophoneEnabled(enabled);
  }

  get isAuthenticated(): boolean {
    return this.authSession !== null;
  }

  get authenticatedFid(): number | null {
    return this.authSession?.fid ?? null;
  }

  private requireAuthenticated(): AuthSession {
    if (!this.authSession) throw new JukeEmbedAuthError();
    return this.authSession;
  }

  private requireConnectedRoom(): Room {
    if (!this.activeRoom) throw new Error("Audio is not connected");
    return this.activeRoom;
  }

  private async disconnectAudio(): Promise<void> {
    const room = this.activeRoom;
    this.activeRoom = null;
    if (room) await room.disconnect().catch(() => {});
    document
      .querySelectorAll("[data-juke-embed-audio='true']")
      .forEach((element) => element.remove());
  }

  private async getFreshAuthSession(): Promise<AuthSession> {
    const session = this.requireAuthenticated();
    const expiresAt = new Date(session.expiresAt).getTime();
    if (
      Number.isFinite(expiresAt) &&
      Date.now() + SESSION_REFRESH_MARGIN_MS < expiresAt
    ) {
      return session;
    }

    // Mini App sessions carry no refresh token: the host wallet signs a
    // fresh Protocol Auth token instead.
    if (session.source === "miniapp") {
      this.authSession = null;
      const renewed = await this.signInWithMiniApp({ force: true });
      if (!renewed) {
        throw new JukeEmbedAuthError(
          "Session expired — sign in with Farcaster again.",
        );
      }
      return renewed;
    }

    // Partner-minted sessions don't ship with a refresh token — the
    // partner is expected to re-mint via their server when needed.
    // Surface a deterministic error so the embed can prompt for sign-in
    // instead of looping a doomed refresh call.
    if (!session.refreshToken) {
      this.authSession = null;
      throw new JukeEmbedAuthError(
        "Partner session expired — re-authenticate via the host site or sign in with Farcaster.",
      );
    }

    const res = await fetch(`${API_BASE_URL}/v1/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.jwt}`,
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    const body = await parseJsonResponse<LoginResponse>(
      res,
      "Could not refresh sign-in",
    );
    return this.storeLoginResponse(body, session.source);
  }

  private storeLoginResponse(
    response: LoginResponse,
    source: JukeEmbedAuthSource,
  ): AuthSession {
    if (!response?.jwt || !Number.isSafeInteger(response.user?.fid)) {
      throw new JukeEmbedAuthError("Sign-in returned an invalid session");
    }
    this.authSession = {
      jwt: response.jwt,
      refreshToken: response.refresh_token ?? "",
      expiresAt: response.expires_at,
      fid: response.user.fid,
      source,
    };
    return this.authSession;
  }
}

type PartnerJwtClaims = { fid: number; exp: number };

/**
 * Decode (but do not verify) a partner-minted Juke JWT to extract the
 * fid and exp claims for client-side UX rendering. Verification happens
 * on the backend on every authed call.
 *
 * Why decode instead of taking fid + exp as separate URL params: keeps
 * the partner integration to a single `?token=` parameter and prevents
 * the partner from passing a fid that disagrees with the signed claim.
 */
const PARTNER_TOKEN_MAX_LENGTH = 4096;

function decodePartnerJwtClaims(token: string): PartnerJwtClaims {
  // Cheap DoS guard before parsing. A real Juke partner JWT is well under
  // 1 KB; anything beyond 4 KB is either malformed or hostile and should
  // never reach `atob`/`JSON.parse`.
  if (token.length > PARTNER_TOKEN_MAX_LENGTH) {
    throw new Error("Partner token is malformed");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Partner token is malformed");
  const payload = parts[1];
  if (!payload) throw new Error("Partner token is malformed");
  let json: string;
  try {
    json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new Error("Partner token is malformed");
  }
  let claims: unknown;
  try {
    claims = JSON.parse(json);
  } catch {
    throw new Error("Partner token is malformed");
  }
  if (typeof claims !== "object" || claims === null) {
    throw new Error("Partner token is malformed");
  }
  const { fid, exp } = claims as { fid?: unknown; exp?: unknown };
  if (typeof fid !== "number" || typeof exp !== "number") {
    throw new Error("Partner token is missing required claims");
  }
  if (Date.now() / 1000 >= exp) {
    throw new Error("Partner token is already expired");
  }
  return { fid, exp };
}

export function createJukeEmbedSdk(): JukeEmbedSdk {
  return new JukeEmbedSdk();
}

function supportsWebRtc(): boolean {
  const AudioCtor =
    typeof window !== "undefined"
      ? window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext
      : null;
  return (
    typeof window !== "undefined" &&
    "RTCPeerConnection" in window &&
    !!AudioCtor
  );
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
    throw new Error(detail);
  }

  return body as T;
}
