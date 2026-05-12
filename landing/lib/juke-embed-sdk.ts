"use client";

import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RoomOptions,
} from "livekit-client";
import {
  API_BASE_URL,
  getSpaceDetail,
  type JoinSpaceResponse,
  type SpaceDetailResponse,
} from "@/lib/spaces";

type AuthSession = {
  jwt: string;
  refreshToken: string;
  expiresAt: string;
  fid: number;
};

type LoginResponse = {
  jwt: string;
  refresh_token: string;
  expires_at: string;
  user: { fid: number };
};

export type SiwnPayload = {
  fid: number | string;
  signer_uuid: string;
  nonce: string;
};

export type StartSiwnResult = {
  authorizationUrl: string;
  popup: Window | null;
  nonce: string;
};

export type SiwnExpectation = { nonce: string; source: Window | null };

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
  constructor(message = "Sign in to participate") {
    super(message);
    this.name = "JukeEmbedAuthError";
  }
}

export class JukeEmbedSdk {
  private authSession: AuthSession | null = null;
  private activeRoom: Room | null = null;
  private activeSpaceId: string | null = null;
  private activeJoin: JoinSpaceResponse | null = null;

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

  async startSiwn(options?: { openPopup?: boolean }): Promise<StartSiwnResult> {
    const res = await fetch(`${API_BASE_URL}/v1/auth/neynar-auth-url`, {
      cache: "no-store",
    });
    const body = await parseJsonResponse<{ authorization_url: string }>(
      res,
      "Could not start sign in",
    );

    const nonce = generateSiwnNonce();
    const authorizationUrl = appendSiwnCallback(body.authorization_url, nonce);
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

  async completeSiwn(payload: SiwnPayload): Promise<AuthSession> {
    const fid =
      typeof payload.fid === "string" ? Number.parseInt(payload.fid, 10) : payload.fid;
    if (!Number.isFinite(fid) || fid <= 0 || !payload.signer_uuid) {
      throw new Error("Invalid sign-in response");
    }

    const res = await fetch(`${API_BASE_URL}/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fid, signer_uuid: payload.signer_uuid }),
    });
    const body = await parseJsonResponse<LoginResponse>(
      res,
      "Could not complete sign in",
    );

    this.authSession = {
      jwt: body.jwt,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_at,
      fid: body.user.fid,
    };
    return this.authSession;
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
    if (Number.isFinite(expiresAt) && Date.now() + 60_000 < expiresAt) {
      return session;
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
    this.authSession = {
      jwt: body.jwt,
      refreshToken: body.refresh_token,
      expiresAt: body.expires_at,
      fid: body.user.fid,
    };
    return this.authSession;
  }
}

export function createJukeEmbedSdk(): JukeEmbedSdk {
  return new JukeEmbedSdk();
}

export function isTrustedSiwnMessage(
  event: MessageEvent,
  expected: SiwnExpectation,
): boolean {
  if (typeof window === "undefined") return false;
  if (event.origin !== window.location.origin) return false;
  if (expected.source && event.source !== expected.source) return false;
  const payload = parseSiwnPayload(event.data);
  return payload !== null && payload.nonce === expected.nonce;
}

export function parseSiwnPayload(data: unknown): SiwnPayload | null {
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
  if (typeof candidate.nonce !== "string" || !candidate.nonce) return null;
  return {
    signer_uuid: candidate.signer_uuid,
    fid: candidate.fid,
    nonce: candidate.nonce,
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
