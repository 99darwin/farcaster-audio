# Farcaster Audio Spaces Client — Technical Specification

**Codename:** TBD
**Version:** 0.1.0 (MVP)
**Platform:** iOS only
**Last updated:** 2026-03-23

---

## Table of contents

1. [Product overview](#1-product-overview)
2. [Architecture overview](#2-architecture-overview)
3. [Project structure](#3-project-structure)
4. [Environment & configuration](#4-environment--configuration)
5. [Data models](#5-data-models)
6. [API contracts — Backend](#6-api-contracts--backend)
7. [Neynar integration](#7-neynar-integration)
8. [LiveKit integration](#8-livekit-integration)
9. [iOS native module — Background audio](#9-ios-native-module--background-audio)
10. [Frontend screens & components](#10-frontend-screens--components)
11. [Speaker management & permissions](#11-speaker-management--permissions)
12. [Room discovery & lifecycle](#12-room-discovery--lifecycle)
13. [Reconnection engine](#13-reconnection-engine)
14. [Recording (v1.1)](#14-recording-v11)
15. [Infrastructure & deployment](#15-infrastructure--deployment)
16. [Development workflow](#16-development-workflow)
17. [Testing strategy](#17-testing-strategy)
18. [Security considerations](#18-security-considerations)
19. [Cost model](#19-cost-model)
20. [Build phases & milestones](#20-build-phases--milestones)

---

## 1. Product overview

### What this is

A turbo-minimal Farcaster client for iOS that does three things:

1. **Login** — Sign in with Farcaster (SIWF) via Neynar. No new signer creation.
2. **Feed** — Chronological following feed with native actions (like, recast, reply). No algorithm.
3. **Audio spaces** — Persistent, concurrent audio rooms that survive app backgrounding, screen sleep, and app switching. This is the primary use case.

### What this is not

- Not a full-featured Farcaster client (no DMs, no channels, no search, no notifications beyond spaces)
- Not cross-platform (iOS only for v1)
- Not a recording/podcast platform (recording is v1.1, replay is v2)

### User flows (critical path)

```
Login:
  Open app → Tap "Sign in with Farcaster" → Neynar SIWF popup → 
  Redirect back → JWT issued → Land on home feed

Join space:
  Home feed → Tap live avatar in top rail → Join as listener → 
  Hear audio immediately → Raise hand → Host promotes → Speak

Create space:
  Home feed → Tap "+" in avatar rail → Enter title → 
  Create room → Auto-join as host → Share (optional cast)

Background persistence:
  In active space → Lock screen → Audio continues →
  Switch to Safari → Audio continues → Return to app → 
  UI reconnects to active room state
```

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────┐
│                  iOS App (Expo)                   │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐ │
│  │ Auth     │  │ Feed     │  │ Audio Spaces   │ │
│  │ (SIWF)   │  │ (Neynar) │  │ (LiveKit RN)   │ │
│  └──────────┘  └──────────┘  └────────────────┘ │
│                                                   │
│  ┌────────────────────────────────────────────┐  │
│  │ Native Module: AVAudioSession + Background │  │
│  └────────────────────────────────────────────┘  │
│                                                   │
│  ┌────────────────────────────────────────────┐  │
│  │ Reconnection Engine (token refresh, rejoin)│  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
              │                        │
              ▼                        ▼
┌──────────────────────┐   ┌──────────────────────┐
│   Backend API        │   │   LiveKit Cloud       │
│   (FastAPI on DO)    │◄─►│   (WebRTC SFU)        │
│                      │   │                       │
│   - Room CRUD        │   │   - Audio transport    │
│   - Token generation │   │   - Participant mgmt   │
│   - Permission model │   │   - Egress (recording) │
│   - User sessions    │   │                       │
└──────────────────────┘   └──────────────────────┘
       │          │
       ▼          ▼
┌───────────┐ ┌────────┐
│ Postgres  │ │ Redis  │
│ (DO mgd)  │ │(Upstash)│
└───────────┘ └────────┘
       │
       ▼
┌──────────────────────┐
│   Neynar API         │
│   - SIWF auth        │
│   - Following feed   │
│   - Reactions         │
│   - Cast creation     │
└──────────────────────┘
```

### Technology choices

| Layer | Technology | Version | Rationale |
|---|---|---|---|
| Framework | Expo (bare workflow) | SDK 55 | MCP integration, EAS builds, native module support |
| Language (mobile) | TypeScript + Swift (native module) | TS 5.x, Swift 5.9 | Type safety, iOS-native audio APIs |
| Navigation | Expo Router | v4 | File-based routing, deep linking |
| State management | Zustand | 5.x | Minimal, no boilerplate, works with RN |
| Audio SDK | @livekit/react-native | latest | Open-source SFU, background audio support |
| WebRTC | @livekit/react-native-webrtc | latest | Required peer dependency for LiveKit RN |
| Backend | FastAPI (Python) | 0.115+ | Async, type hints, OpenAPI docs auto-gen |
| Database | PostgreSQL | 16 | DigitalOcean managed |
| Cache/pubsub | Redis | 7.x | Upstash serverless or DO managed |
| Auth provider | Neynar | v2 API | SIWF, feed, reactions, hub proxy |
| Audio infra | LiveKit Cloud | — | WebRTC SFU, egress for recording |
| Build/deploy | EAS Build + EAS Submit | — | CI/CD to TestFlight |

---

## 3. Project structure

```
farcaster-audio/
├── app/                          # Expo Router screens
│   ├── _layout.tsx               # Root layout (auth gate, providers)
│   ├── index.tsx                 # Home (feed + spaces rail)
│   ├── login.tsx                 # SIWF login screen
│   ├── space/
│   │   ├── [id].tsx              # Active space screen
│   │   └── create.tsx            # Create space flow
│   └── cast/
│       └── [hash].tsx            # Individual cast thread (stretch)
├── components/
│   ├── feed/
│   │   ├── CastCard.tsx          # Individual cast in feed
│   │   ├── FeedList.tsx          # Virtualized feed list
│   │   └── CastActions.tsx       # Like, recast, reply buttons
│   ├── spaces/
│   │   ├── SpacesRail.tsx        # Horizontal avatar scroll
│   │   ├── SpaceAvatar.tsx       # Single avatar with live ring
│   │   ├── SpeakerGrid.tsx       # Speaker avatars in active space
│   │   ├── ListenerList.tsx      # Listener avatars (collapsed)
│   │   ├── HandRaiseButton.tsx   # Raise/lower hand toggle
│   │   ├── HostControls.tsx      # Mute/kick/promote/end controls
│   │   └── SpaceMiniBar.tsx      # Persistent bottom bar when in space
│   └── common/
│       ├── Avatar.tsx            # Farcaster avatar with fallback
│       ├── Button.tsx            # Shared button component
│       └── LoadingSpinner.tsx
├── hooks/
│   ├── useAuth.ts                # Auth state + SIWF flow
│   ├── useFeed.ts                # Feed fetching + pagination
│   ├── useSpace.ts               # Space join/leave/state
│   ├── useSpacePermissions.ts    # Role-based permission checks
│   ├── useReconnect.ts           # Reconnection logic
│   └── useLiveSpaces.ts          # Poll/subscribe for active spaces
├── stores/
│   ├── authStore.ts              # Zustand: user session, JWT, FID
│   ├── spaceStore.ts             # Zustand: active space state
│   └── feedStore.ts              # Zustand: feed cache
├── services/
│   ├── api.ts                    # Backend API client (axios/fetch)
│   ├── neynar.ts                 # Neynar API wrapper
│   ├── livekit.ts                # LiveKit token + room helpers
│   └── storage.ts                # Secure storage (expo-secure-store)
├── native/
│   └── AudioSessionModule/
│       ├── AudioSessionModule.swift      # AVAudioSession native module
│       ├── AudioSessionModule.m          # Obj-C bridging header
│       └── AudioSessionModuleBridge.swift # Expo module bridge
├── types/
│   ├── api.ts                    # Backend API types
│   ├── neynar.ts                 # Neynar response types
│   ├── space.ts                  # Space/room types
│   └── user.ts                   # User/profile types
├── constants/
│   └── config.ts                 # API URLs, feature flags
├── app.json                      # Expo config
├── eas.json                      # EAS Build config
├── tsconfig.json
├── package.json
└── ios/
    └── Podfile                   # CocoaPods (auto-managed by Expo)
```

### Backend structure

```
backend/
├── app/
│   ├── main.py                   # FastAPI app entry
│   ├── config.py                 # Settings (pydantic-settings)
│   ├── dependencies.py           # Dependency injection (db, redis, livekit)
│   ├── models/
│   │   ├── __init__.py
│   │   ├── user.py               # SQLAlchemy User model
│   │   ├── room.py               # SQLAlchemy Room model
│   │   ├── participant.py        # SQLAlchemy Participant model
│   │   └── ban.py                # SQLAlchemy Ban model
│   ├── schemas/
│   │   ├── __init__.py
│   │   ├── auth.py               # Pydantic: login request/response
│   │   ├── room.py               # Pydantic: room CRUD
│   │   ├── participant.py        # Pydantic: participant actions
│   │   └── common.py             # Shared schemas
│   ├── routers/
│   │   ├── __init__.py
│   │   ├── auth.py               # POST /auth/login, /auth/refresh
│   │   ├── rooms.py              # Room CRUD + listing
│   │   ├── participants.py       # Join, leave, permissions
│   │   └── webhooks.py           # LiveKit webhook receiver
│   ├── services/
│   │   ├── __init__.py
│   │   ├── auth_service.py       # Neynar SIWF verification, JWT
│   │   ├── room_service.py       # Room lifecycle logic
│   │   ├── livekit_service.py    # LiveKit server SDK wrapper
│   │   ├── permission_service.py # Role/permission enforcement
│   │   └── redis_service.py      # Room state cache, pub/sub
│   └── middleware/
│       ├── __init__.py
│       └── auth_middleware.py     # JWT verification middleware
├── alembic/                      # Database migrations
│   ├── versions/
│   └── env.py
├── alembic.ini
├── requirements.txt
├── Dockerfile
└── docker-compose.yml            # Local dev (postgres + redis + app)
```

---

## 4. Environment & configuration

### Mobile app — `constants/config.ts`

```typescript
export const Config = {
  API_BASE_URL: __DEV__
    ? 'http://localhost:8000'
    : 'https://api.APPNAME.xyz',

  NEYNAR_CLIENT_ID: process.env.EXPO_PUBLIC_NEYNAR_CLIENT_ID!,
  NEYNAR_API_KEY: process.env.EXPO_PUBLIC_NEYNAR_API_KEY!,
  NEYNAR_API_BASE: 'https://api.neynar.com/v2',

  LIVEKIT_WS_URL: __DEV__
    ? 'wss://APPNAME-dev.livekit.cloud'
    : 'wss://APPNAME-prod.livekit.cloud',

  // Feature flags
  RECORDING_ENABLED: false, // v1.1
  MAX_SPEAKERS: 10,
  MAX_LISTENERS: 500,
  RECONNECT_MAX_ATTEMPTS: 5,
  RECONNECT_BASE_DELAY_MS: 1000,
  TOKEN_REFRESH_BUFFER_SEC: 300, // refresh 5 min before expiry
} as const;
```

### Backend — `app/config.py`

```python
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    # Database
    DATABASE_URL: str  # postgresql+asyncpg://user:pass@host:5432/db
    REDIS_URL: str     # redis://default:pass@host:6379

    # Auth
    JWT_SECRET: str
    JWT_ALGORITHM: str = "HS256"
    JWT_EXPIRY_HOURS: int = 72
    JWT_REFRESH_EXPIRY_DAYS: int = 30

    # Neynar
    NEYNAR_API_KEY: str
    NEYNAR_CLIENT_ID: str

    # LiveKit
    LIVEKIT_API_KEY: str
    LIVEKIT_API_SECRET: str
    LIVEKIT_WS_URL: str  # wss://APPNAME-prod.livekit.cloud

    # App
    ENVIRONMENT: str = "development"  # development | staging | production
    CORS_ORIGINS: list[str] = ["*"]
    LOG_LEVEL: str = "INFO"

    # Recording (v1.1)
    S3_BUCKET: str = ""
    S3_REGION: str = "us-east-1"
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    RECORDING_ENABLED: bool = False

    class Config:
        env_file = ".env"

settings = Settings()
```

### EAS configuration — `eas.json`

```json
{
  "cli": { "version": ">= 12.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "ios": {
        "simulator": true
      }
    },
    "preview": {
      "distribution": "internal",
      "ios": {
        "buildConfiguration": "Release"
      }
    },
    "production": {
      "ios": {
        "buildConfiguration": "Release",
        "autoIncrement": true
      }
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "APPLE_ID",
        "ascAppId": "ASC_APP_ID",
        "appleTeamId": "TEAM_ID"
      }
    }
  }
}
```

### iOS Info.plist additions (via `app.json` plugins or direct)

```json
{
  "expo": {
    "ios": {
      "infoPlist": {
        "UIBackgroundModes": ["audio"],
        "NSMicrophoneUsageDescription": "Required to speak in audio spaces",
        "CFBundleURLTypes": [
          {
            "CFBundleURLSchemes": ["APPNAME"]
          }
        ]
      }
    }
  }
}
```

---

## 5. Data models

### PostgreSQL schema

```sql
-- Users table: minimal, populated on first login
CREATE TABLE users (
    id              SERIAL PRIMARY KEY,
    fid             BIGINT UNIQUE NOT NULL,           -- Farcaster ID
    signer_uuid     VARCHAR(128) NOT NULL,            -- Neynar signer for server-side API calls
    username        VARCHAR(64),
    display_name    VARCHAR(256),
    pfp_url         TEXT,
    custody_address VARCHAR(42),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_fid ON users(fid);

-- Rooms table: audio space metadata
CREATE TABLE rooms (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           VARCHAR(256) NOT NULL,
    host_fid        BIGINT NOT NULL REFERENCES users(fid),
    status          VARCHAR(20) NOT NULL DEFAULT 'active',
        -- active | ended | cancelled
    livekit_room_id VARCHAR(128),
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    max_speakers    INT DEFAULT 10,
    max_listeners   INT DEFAULT 500,
    recording       BOOLEAN DEFAULT FALSE,
    recording_url   TEXT,
    cast_hash       VARCHAR(66),  -- hash of the announcement cast, if any
    metadata        JSONB DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_rooms_status ON rooms(status);
CREATE INDEX idx_rooms_host ON rooms(host_fid);
CREATE INDEX idx_rooms_started ON rooms(started_at DESC);

-- Participants: join/leave log + current state
CREATE TABLE participants (
    id              SERIAL PRIMARY KEY,
    room_id         UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    fid             BIGINT NOT NULL REFERENCES users(fid),
    role            VARCHAR(20) NOT NULL DEFAULT 'listener',
        -- host | co_host | speaker | listener
    is_muted        BOOLEAN DEFAULT TRUE,
    hand_raised     BOOLEAN DEFAULT FALSE,
    joined_at       TIMESTAMPTZ DEFAULT NOW(),
    left_at         TIMESTAMPTZ,
    UNIQUE(room_id, fid)
);

CREATE INDEX idx_participants_room ON participants(room_id);
CREATE INDEX idx_participants_active ON participants(room_id) WHERE left_at IS NULL;

-- Bans: host can ban users from their rooms
CREATE TABLE bans (
    id              SERIAL PRIMARY KEY,
    room_id         UUID REFERENCES rooms(id) ON DELETE CASCADE,  -- NULL = global ban by admin
    banned_fid      BIGINT NOT NULL REFERENCES users(fid),
    banned_by_fid   BIGINT NOT NULL REFERENCES users(fid),
    reason          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,  -- NULL = permanent
    UNIQUE(room_id, banned_fid)
);

CREATE INDEX idx_bans_room ON bans(room_id, banned_fid);
CREATE INDEX idx_bans_user ON bans(banned_fid);
```

### Redis keys

```
# Active room state (expires when room ends)
room:{room_id}:state        → JSON {
    id, title, host_fid, status, started_at,
    speaker_count, listener_count, recording
}
room:{room_id}:participants → HASH {
    fid → JSON { role, is_muted, hand_raised, display_name, pfp_url }
}
room:{room_id}:hand_queue   → LIST [fid1, fid2, ...]  # ordered raise time

# Active rooms index (for discovery)
active_rooms                → SORTED SET {
    room_id → started_at_timestamp  (score = timestamp for ordering)
}

# User session state
user:{fid}:active_room      → room_id  (which room the user is currently in)

# Pub/sub channels
room:{room_id}:events       → PUB/SUB channel for real-time updates
    Event payloads:
    { type: "participant_joined", fid, role }
    { type: "participant_left", fid }
    { type: "role_changed", fid, old_role, new_role }
    { type: "hand_raised", fid }
    { type: "hand_lowered", fid }
    { type: "mute_changed", fid, is_muted }
    { type: "room_ended" }
    { type: "recording_started" }
    { type: "recording_stopped" }
```

### TypeScript types — `types/space.ts`

```typescript
export type RoomStatus = 'active' | 'ended' | 'cancelled';
export type ParticipantRole = 'host' | 'co_host' | 'speaker' | 'listener';

export interface Room {
  id: string;
  title: string;
  host_fid: number;
  host: UserProfile;
  status: RoomStatus;
  started_at: string;
  ended_at: string | null;
  speaker_count: number;
  listener_count: number;
  recording: boolean;
  cast_hash: string | null;
}

export interface Participant {
  fid: number;
  role: ParticipantRole;
  is_muted: boolean;
  hand_raised: boolean;
  display_name: string;
  pfp_url: string | null;
}

export interface SpaceState {
  room: Room;
  participants: Participant[];
  hand_queue: number[];       // fids in raise order
  my_role: ParticipantRole;
  is_connected: boolean;
}

export interface RoomEvent {
  type:
    | 'participant_joined'
    | 'participant_left'
    | 'role_changed'
    | 'hand_raised'
    | 'hand_lowered'
    | 'mute_changed'
    | 'room_ended'
    | 'recording_started'
    | 'recording_stopped';
  fid?: number;
  role?: ParticipantRole;
  old_role?: ParticipantRole;
  is_muted?: boolean;
}
```

### TypeScript types — `types/user.ts`

```typescript
export interface UserProfile {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
  custody_address: string;
}

export interface AuthState {
  user: UserProfile | null;
  jwt: string | null;
  refresh_token: string | null;
  is_authenticated: boolean;
  is_loading: boolean;
}
```

---

## 6. API contracts — Backend

Base URL: `https://api.APPNAME.xyz/v1`

All authenticated endpoints require `Authorization: Bearer <jwt>`.

### Auth

#### `GET /v1/auth/neynar-auth-url`

Returns the Neynar authorization URL for SIWN. Called by the client before initiating the sign-in flow.

**Response (200):**
```json
{
  "authorization_url": "https://app.neynar.com/login?client_id=...&response_type=code"
}
```

#### `POST /v1/auth/login`

Called after SIWN completes on the client. Client sends the Neynar signer UUID and the user's FID. Backend verifies with Neynar, creates/updates local user, stores `signer_uuid` for server-side API calls, returns JWT.

**Request:**
```json
{
  "signer_uuid": "string",
  "fid": 12345
}
```

**Response (200):**
```json
{
  "jwt": "eyJ...",
  "refresh_token": "rt_...",
  "expires_at": "2026-03-26T00:00:00Z",
  "user": {
    "fid": 12345,
    "username": "nick",
    "display_name": "Nick",
    "pfp_url": "https://...",
    "custody_address": "0x..."
  }
}
```

#### `POST /v1/auth/refresh`

**Request:**
```json
{
  "refresh_token": "rt_..."
}
```

**Response (200):** Same shape as login response with fresh tokens.

### Rooms

#### `GET /v1/rooms`

List active rooms for the spaces discovery rail.

**Query params:**
- `status` — `active` (default) | `ended`
- `limit` — int, default 20, max 50
- `cursor` — pagination cursor (room_id)

**Response (200):**
```json
{
  "rooms": [
    {
      "id": "uuid",
      "title": "Farcaster dev talk",
      "host_fid": 12345,
      "host": { "fid": 12345, "username": "nick", "display_name": "Nick", "pfp_url": "..." },
      "status": "active",
      "started_at": "2026-03-23T10:00:00Z",
      "ended_at": null,
      "speaker_count": 3,
      "listener_count": 47,
      "recording": false,
      "cast_hash": null
    }
  ],
  "next_cursor": "uuid_or_null"
}
```

#### `POST /v1/rooms`

Create a new room. Caller becomes host.

**Request:**
```json
{
  "title": "Farcaster dev talk",
  "announce_cast": true
}
```

**Response (201):**
```json
{
  "room": { /* Room object */ },
  "livekit_token": "eyJ...",
  "livekit_ws_url": "wss://..."
}
```

**Side effects:**
- Creates LiveKit room via server SDK
- Sets host as first participant in Redis
- If `announce_cast: true`, posts a cast via Neynar with room link

#### `GET /v1/rooms/:room_id`

Full room state including participant list.

**Response (200):**
```json
{
  "room": { /* Room object */ },
  "participants": [
    { "fid": 12345, "role": "host", "is_muted": false, "hand_raised": false, "display_name": "Nick", "pfp_url": "..." },
    { "fid": 67890, "role": "speaker", "is_muted": true, "hand_raised": false, "display_name": "...", "pfp_url": "..." }
  ],
  "hand_queue": [11111, 22222]
}
```

#### `DELETE /v1/rooms/:room_id`

End a room. Host or co-host only.

**Response (200):**
```json
{ "status": "ended" }
```

**Side effects:**
- Sets room status to `ended`, sets `ended_at`
- Disconnects all LiveKit participants
- Clears Redis state
- Stops recording if active

### Participants

#### `POST /v1/rooms/:room_id/join`

Join a room as listener. Returns LiveKit token.

**Response (200):**
```json
{
  "livekit_token": "eyJ...",
  "livekit_ws_url": "wss://...",
  "role": "listener",
  "room": { /* Room object */ },
  "participants": [ /* ... */ ]
}
```

**Error (403):**
```json
{ "detail": "You are banned from this room" }
```

#### `POST /v1/rooms/:room_id/leave`

Leave a room. Cleans up participant state.

**Response (200):**
```json
{ "status": "left" }
```

#### `POST /v1/rooms/:room_id/raise-hand`

Toggle hand raise for current user.

**Request:**
```json
{ "raised": true }
```

**Response (200):**
```json
{ "hand_raised": true, "queue_position": 3 }
```

#### `POST /v1/rooms/:room_id/participants/:fid/promote`

Host/co-host promotes a listener to speaker.

**Response (200):**
```json
{ "fid": 67890, "role": "speaker" }
```

**Side effects:**
- Updates Redis participant hash
- Updates LiveKit participant metadata
- Publishes `role_changed` event
- Grants publish permission in LiveKit

#### `POST /v1/rooms/:room_id/participants/:fid/demote`

Host/co-host demotes a speaker to listener.

**Response (200):**
```json
{ "fid": 67890, "role": "listener" }
```

**Side effects:**
- Updates Redis + LiveKit metadata
- Revokes publish permission in LiveKit (auto-mutes)

#### `POST /v1/rooms/:room_id/participants/:fid/mute`

Host/co-host mutes a participant.

**Response (200):**
```json
{ "fid": 67890, "is_muted": true }
```

**Side effects:**
- Calls LiveKit `MutePublishedTrack` server API

#### `POST /v1/rooms/:room_id/participants/:fid/kick`

Host/co-host removes a participant.

**Response (200):**
```json
{ "fid": 67890, "status": "kicked" }
```

**Side effects:**
- Calls LiveKit `RemoveParticipant`
- Cleans up Redis state

#### `POST /v1/rooms/:room_id/participants/:fid/ban`

Host/co-host bans a participant.

**Request:**
```json
{
  "reason": "disruptive behavior",
  "duration_hours": 24
}
```

**Response (200):**
```json
{ "fid": 67890, "status": "banned", "expires_at": "2026-03-24T10:00:00Z" }
```

**Side effects:**
- Kicks participant first
- Creates ban record in Postgres
- Future join attempts check bans table

### Token refresh

#### `POST /v1/rooms/:room_id/token`

Get a fresh LiveKit token for reconnection. Used by the reconnect engine when the current token is nearing expiry.

**Response (200):**
```json
{
  "livekit_token": "eyJ...",
  "expires_at": "2026-03-23T12:00:00Z"
}
```

---

## 7. Neynar integration

### Sign in with Neynar (SIWN) — React Native

Neynar provides a dedicated React Native package: `@neynar/react-native-signin`.

**Package:** `@neynar/react-native-signin`
**Docs:** https://docs.neynar.com/docs/sign-in-with-neynar-react-native-implementation
**Reference repo:** https://github.com/neynarxyz/farcaster-examples/tree/main/wownar-react-native

**Architecture:** The SIWN flow requires a server-side component to fetch the authorization URL (keeps the API key off the client). Our FastAPI backend handles this.

**Backend routes for SIWN:**

```python
# routers/auth.py

@router.get("/v1/auth/neynar-auth-url")
async def get_auth_url():
    """Fetch the Neynar authorization URL. Called by the RN client before opening SIWN."""
    async with httpx.AsyncClient() as client:
        resp = await client.get(
            "https://app.neynar.com/login",
            params={
                "client_id": settings.NEYNAR_CLIENT_ID,
                "response_type": "code",
            },
            headers={"api_key": settings.NEYNAR_API_KEY},
        )
    return {"authorization_url": str(resp.url)}
```

**Client-side SIWN component:**

```typescript
// components/auth/SignInButton.tsx
import { NeynarSigninButton } from '@neynar/react-native-signin';
import { api } from '@/services/api';

export function SignInButton() {
  const { setAuth } = useAuthStore();

  const fetchAuthorizationUrl = async () => {
    const { authorization_url } = await api.get('/v1/auth/neynar-auth-url');
    return authorization_url;
  };

  const handleSuccess = async (data: { signer_uuid: string; fid: number }) => {
    // Send to our backend for JWT issuance
    const authResponse = await api.post('/v1/auth/login', {
      signer_uuid: data.signer_uuid,
      fid: data.fid,
    });
    setAuth(authResponse);
  };

  const handleError = (error: Error) => {
    console.error('SIWN error:', error);
  };

  return (
    <NeynarSigninButton
      fetchAuthorizationUrl={fetchAuthorizationUrl}
      successCallback={handleSuccess}
      errorCallback={handleError}
      redirectUrl="APPNAME://auth/callback"
      // Customization options available — see Neynar docs
    />
  );
}
```

**Flow:**

1. Client calls our backend `GET /v1/auth/neynar-auth-url` to get the auth URL
2. `NeynarSigninButton` opens the URL (in-app browser)
3. User authenticates with their Farcaster account on Neynar
4. Neynar redirects to `APPNAME://auth/callback` with `signer_uuid` and `fid`
5. `successCallback` fires with the signer data
6. Client sends `signer_uuid` + `fid` to our backend `POST /v1/auth/login`
7. Backend verifies the signer: `GET https://api.neynar.com/v2/farcaster/signer?signer_uuid=...`
8. If valid, backend fetches user profile via Neynar `fetchBulkUsers`, creates/updates local user, issues JWT

**Important:** We are NOT creating new signers. We only authenticate users who already have a Farcaster account with an existing signer. The `signer_uuid` from SIWN is stored server-side and used for Neynar API calls on behalf of the user (reactions, casts).

### Feed endpoint

```typescript
// Following feed for authenticated user
GET https://api.neynar.com/v2/farcaster/feed/following
Headers: { 'api_key': NEYNAR_API_KEY }
Query: {
  fid: number,        // authenticated user's FID
  limit: 25,          // default page size
  cursor?: string     // pagination
}
```

Response is an array of cast objects. Map to our `CastCard` component.

### Reaction endpoints

```typescript
// Like a cast
POST https://api.neynar.com/v2/farcaster/reaction
Headers: { 'api_key': NEYNAR_API_KEY }
Body: {
  signer_uuid: string,
  reaction_type: 'like',
  target: cast_hash
}

// Recast
POST https://api.neynar.com/v2/farcaster/reaction
Body: {
  signer_uuid: string,
  reaction_type: 'recast',
  target: cast_hash
}
```

### Cast creation (for space announcements)

```typescript
// Post a cast announcing a new space
POST https://api.neynar.com/v2/farcaster/cast
Headers: { 'api_key': NEYNAR_API_KEY }
Body: {
  signer_uuid: string,
  text: "🔴 Live now: Farcaster dev talk\n\nJoin in APPNAME →",
  embeds: [
    { url: "https://APPNAME.xyz/space/{room_id}" }
  ]
}
```

---

## 8. LiveKit integration

### Server SDK (backend — Python)

```python
from livekit import api

# Initialize
livekit_api = api.LiveKitAPI(
    url=settings.LIVEKIT_WS_URL,
    api_key=settings.LIVEKIT_API_KEY,
    api_secret=settings.LIVEKIT_API_SECRET,
)

# Create room
async def create_livekit_room(room_id: str, title: str) -> None:
    await livekit_api.room.create_room(
        api.CreateRoomRequest(
            name=room_id,
            metadata=json.dumps({"title": title}),
            empty_timeout=300,        # 5 min grace period when empty
            max_participants=510,     # 10 speakers + 500 listeners
        )
    )

# Generate participant token
def generate_token(
    room_id: str,
    fid: int,
    display_name: str,
    role: str,
) -> str:
    token = api.AccessToken(
        api_key=settings.LIVEKIT_API_KEY,
        api_secret=settings.LIVEKIT_API_SECRET,
    )
    token.with_identity(str(fid))
    token.with_name(display_name)
    token.with_metadata(json.dumps({"fid": fid, "role": role}))
    token.with_ttl(datetime.timedelta(hours=6))

    grant = api.VideoGrants(
        room_join=True,
        room=room_id,
        can_publish=role in ('host', 'co_host', 'speaker'),
        can_subscribe=True,
        can_publish_data=role in ('host', 'co_host', 'speaker'),
    )
    token.with_grants(grant)
    return token.to_jwt()

# Mute a participant's track
async def mute_participant(room_id: str, identity: str) -> None:
    # Get participant's tracks first
    participant = await livekit_api.room.get_participant(
        api.RoomParticipantIdentity(room=room_id, identity=identity)
    )
    for track in participant.tracks:
        if track.type == api.TrackType.AUDIO:
            await livekit_api.room.mute_published_track(
                api.MuteRoomTrackRequest(
                    room=room_id,
                    identity=identity,
                    track_sid=track.sid,
                    muted=True,
                )
            )

# Remove participant
async def kick_participant(room_id: str, identity: str) -> None:
    await livekit_api.room.remove_participant(
        api.RoomParticipantIdentity(room=room_id, identity=identity)
    )

# Update participant permissions (promote/demote)
async def update_permissions(
    room_id: str, identity: str, can_publish: bool
) -> None:
    await livekit_api.room.update_participant(
        api.UpdateParticipantRequest(
            room=room_id,
            identity=identity,
            permission=api.ParticipantPermission(
                can_publish=can_publish,
                can_subscribe=True,
                can_publish_data=can_publish,
            ),
        )
    )
```

### Client SDK (React Native)

```typescript
// hooks/useSpace.ts
import {
  useRoom,
  useParticipants,
  AudioSession,
  Room,
  RoomOptions,
  ConnectionState,
} from '@livekit/react-native';
import { NativeModules } from 'react-native';

const { AudioSessionModule } = NativeModules;

export function useSpace(roomId: string) {
  const spaceStore = useSpaceStore();
  const room = useRef<Room | null>(null);

  const connect = async (token: string, wsUrl: string) => {
    // 1. Configure native audio session FIRST
    await AudioSessionModule.configureForVoiceChat();

    // 2. Start LiveKit audio session
    await AudioSession.startAudioSession();

    // 3. Connect to room
    const roomOptions: RoomOptions = {
      adaptiveStream: false,  // audio only, no video
      dynacast: false,
      publishDefaults: {
        audioPreset: {
          maxBitrate: 48_000,   // 48kbps Opus, good quality for voice
        },
      },
    };

    room.current = new Room(roomOptions);
    await room.current.connect(wsUrl, token, {
      autoSubscribe: true,
    });

    // 4. Set up event listeners
    room.current.on('participantConnected', handleParticipantJoined);
    room.current.on('participantDisconnected', handleParticipantLeft);
    room.current.on('trackMuted', handleTrackMuted);
    room.current.on('trackUnmuted', handleTrackUnmuted);
    room.current.on('disconnected', handleDisconnected);
    room.current.on('reconnecting', handleReconnecting);
    room.current.on('reconnected', handleReconnected);
  };

  const disconnect = async () => {
    if (room.current) {
      await room.current.disconnect();
      room.current = null;
    }
    await AudioSession.stopAudioSession();
    await AudioSessionModule.deactivate();
  };

  const toggleMute = async () => {
    const localParticipant = room.current?.localParticipant;
    if (!localParticipant) return;

    const audioTrack = localParticipant.audioTrackPublications.values().next().value;
    if (audioTrack?.track) {
      if (audioTrack.isMuted) {
        await audioTrack.track.unmute();
      } else {
        await audioTrack.track.mute();
      }
    }
  };

  const startSpeaking = async () => {
    const localParticipant = room.current?.localParticipant;
    if (!localParticipant) return;

    // Enable microphone (only works if permissions allow publishing)
    await localParticipant.setMicrophoneEnabled(true);
  };

  return { connect, disconnect, toggleMute, startSpeaking, room };
}
```

### LiveKit webhook receiver (backend)

```python
# routers/webhooks.py
from livekit import api as livekit_api

@router.post("/v1/webhooks/livekit")
async def livekit_webhook(request: Request):
    body = await request.body()
    auth_header = request.headers.get("Authorization", "")

    # Verify webhook signature
    token_verifier = livekit_api.TokenVerifier(
        api_key=settings.LIVEKIT_API_KEY,
        api_secret=settings.LIVEKIT_API_SECRET,
    )
    event = livekit_api.WebhookReceiver(token_verifier).receive(
        body.decode(), auth_header
    )

    match event.event:
        case "participant_joined":
            await handle_participant_joined(event)
        case "participant_left":
            await handle_participant_left(event)
        case "room_finished":
            await handle_room_finished(event)
        case "track_published":
            await handle_track_published(event)
        case "egress_ended":
            await handle_egress_ended(event)

    return {"status": "ok"}
```

---

## 9. iOS native module — Background audio

This is the most critical native code. It configures `AVAudioSession` so that audio continues when the app is backgrounded or the screen locks.

### `native/AudioSessionModule/AudioSessionModule.swift`

```swift
import ExpoModulesCore
import AVFoundation

public class AudioSessionModule: Module {
    public func definition() -> ModuleDefinition {
        Name("AudioSessionModule")

        AsyncFunction("configureForVoiceChat") { () -> Bool in
            let session = AVAudioSession.sharedInstance()

            do {
                // Category: playAndRecord enables both speaker and mic
                // Mode: voiceChat applies echo cancellation + AGC
                // Options:
                //   - allowBluetooth: AirPods, headsets
                //   - defaultToSpeaker: use speaker not earpiece when no headphones
                //   - mixWithOthers: false — we want exclusive audio
                try session.setCategory(
                    .playAndRecord,
                    mode: .voiceChat,
                    options: [
                        .allowBluetooth,
                        .allowBluetoothA2DP,
                        .defaultToSpeaker
                    ]
                )
                try session.setActive(true, options: .notifyOthersOnDeactivation)

                // Register for interruption notifications (phone call, Siri, etc.)
                NotificationCenter.default.addObserver(
                    forName: AVAudioSession.interruptionNotification,
                    object: session,
                    queue: .main
                ) { [weak self] notification in
                    self?.handleInterruption(notification)
                }

                // Register for route change notifications (headphone plug/unplug)
                NotificationCenter.default.addObserver(
                    forName: AVAudioSession.routeChangeNotification,
                    object: session,
                    queue: .main
                ) { [weak self] notification in
                    self?.handleRouteChange(notification)
                }

                return true
            } catch {
                print("AVAudioSession configuration failed: \(error)")
                return false
            }
        }

        AsyncFunction("deactivate") { () -> Bool in
            let session = AVAudioSession.sharedInstance()
            do {
                try session.setActive(false, options: .notifyOthersOnDeactivation)
                NotificationCenter.default.removeObserver(self)
                return true
            } catch {
                return false
            }
        }

        AsyncFunction("setToSpeaker") { () -> Bool in
            let session = AVAudioSession.sharedInstance()
            do {
                try session.overrideOutputAudioPort(.speaker)
                return true
            } catch {
                return false
            }
        }

        AsyncFunction("setToEarpiece") { () -> Bool in
            let session = AVAudioSession.sharedInstance()
            do {
                try session.overrideOutputAudioPort(.none)
                return true
            } catch {
                return false
            }
        }

        // Expose events to JS
        Events("onAudioInterruption", "onRouteChange")
    }

    private func handleInterruption(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeValue) else {
            return
        }

        switch type {
        case .began:
            // Audio interrupted (phone call, Siri)
            // LiveKit handles pause internally, but we notify JS
            sendEvent("onAudioInterruption", ["type": "began"])
        case .ended:
            // Try to resume audio session
            if let optionsValue = userInfo[AVAudioSessionInterruptionOptionKey] as? UInt {
                let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
                if options.contains(.shouldResume) {
                    try? AVAudioSession.sharedInstance().setActive(true)
                    sendEvent("onAudioInterruption", ["type": "ended", "shouldResume": true])
                }
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ notification: Notification) {
        guard let userInfo = notification.userInfo,
              let reasonValue = userInfo[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: reasonValue) else {
            return
        }

        let currentRoute = AVAudioSession.sharedInstance().currentRoute
        let outputType = currentRoute.outputs.first?.portType.rawValue ?? "unknown"

        sendEvent("onRouteChange", [
            "reason": reason.rawValue,
            "outputType": outputType
        ])
    }
}
```

### Key iOS background audio requirements

1. `UIBackgroundModes: ["audio"]` in Info.plist (set via app.json)
2. `AVAudioSession` category `.playAndRecord` with mode `.voiceChat`
3. Session must be activated BEFORE LiveKit connects
4. Session stays active in background — iOS does NOT kill it as long as audio is flowing
5. On interruption end (phone call ends), reactivate the session and signal reconnect
6. Handle route changes (Bluetooth disconnect, headphone unplug) gracefully

### What the simulator CANNOT test

- Background audio persistence (simulator doesn't enforce background modes)
- Bluetooth audio routing
- Phone call interruptions
- Screen lock behavior
- Cellular/WiFi handoffs
- Memory pressure eviction

All of these require a physical device.

---

## 10. Frontend screens & components

### Screen: Home (`app/index.tsx`)

```
┌──────────────────────────────┐
│  Home                    🔍 👤│  ← header: title + search + profile
│                              │
│  (●)(●)(●)(○)(+)             │  ← SpacesRail: live spaces as avatars
│  dan jesse lena karla Start  │     coral ring = live, tap to join
│──────────────────────────────│
│  ┌────────────────────────┐  │
│  │ VB  v · 2h             │  │  ← CastCard
│  │     the farcaster audio│  │
│  │     space experience...│  │
│  │     ♥ 12  🔁 3  💬 8   │  │  ← CastActions
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ TK  ted · 4h           │  │
│  │     shipped a new frame│  │
│  │     ♥ 24  🔁 7  💬 5   │  │
│  └────────────────────────┘  │
│                              │
│  ┌──────────────────────┐    │  ← SpaceMiniBar (when in active space)
│  │ 🔴 Farcaster dev talk │    │     persistent, tappable to return
│  │    🎤 Mute  |  Leave  │    │
│  └──────────────────────┘    │
└──────────────────────────────┘
```

### SpacesRail behavior

- Horizontal scrollable row of avatars
- Live spaces: coral ring (#D85A30) with red dot indicator, sorted by listener count desc
- `+` button at end to create new space
- Tap live avatar → navigate to `space/[id]`
- Tap `+` → navigate to `space/create`
- Data source: `GET /v1/rooms?status=active`, poll every 15s (or WebSocket later)

### Screen: Active Space (`app/space/[id].tsx`)

```
┌──────────────────────────────┐
│  ← Back     Farcaster dev talk│  ← header with room title
│             🔴 Live · 47      │  ← status + listener count
│──────────────────────────────│
│                              │
│  Speakers                    │
│  ┌────┐ ┌────┐ ┌────┐       │
│  │ NC │ │ DW │ │ JM │       │  ← SpeakerGrid: avatars in grid
│  │host│ │ 🔇 │ │    │       │     host badge, mute indicator
│  └────┘ └────┘ └────┘       │
│                              │
│  Listeners (44)              │
│  (○)(○)(○)(○)(○)(○)(○)...    │  ← ListenerList: smaller avatars
│                              │
│──────────────────────────────│
│  [🤚 Raise hand]      [🔇]  │  ← bottom controls
│        OR                    │     listener: raise hand + mute toggle
│  [🎤 Unmute]  [🔇 Mute]     │     speaker: mute toggle
│        OR                    │
│  [⚙ Host controls]   [End]  │     host: settings + end space
└──────────────────────────────┘
```

### Host controls panel (modal/bottom sheet)

Available to `host` and `co_host` only:

- List of speakers with mute/demote buttons per speaker
- Hand queue: ordered list of raised hands with accept/reject per user
- Kick button per any non-host participant
- Ban button (with optional duration)
- Toggle recording on/off (v1.1)
- Set co-host (promote someone to co_host role)
- End space (confirmation dialog)

### SpaceMiniBar

Persistent floating bar at bottom of any screen when user is in an active space:

- Shows room title + live indicator
- Mute/unmute toggle
- Leave button
- Tap the bar body to navigate back to the space screen
- Must remain visible across all app screens (rendered in root layout)
- Uses Zustand `spaceStore` to know if user is in a space

### Component: CastCard

Props: `{ cast: NeynarCast }`

Displays:
- Author avatar + username + relative timestamp
- Cast text (plain, no embeds rendering for MVP)
- CastActions row: like count + recast count + reply count
- Like/recast are toggle actions calling Neynar reaction endpoints
- Reply navigates to cast thread (stretch goal, can just deep-link to Warpcast for MVP)

---

## 11. Speaker management & permissions

### Role hierarchy

```
host > co_host > speaker > listener
```

### Permission matrix

| Action | Host | Co-host | Speaker | Listener |
|---|---|---|---|---|
| Publish audio | yes | yes | yes | no |
| Self mute/unmute | yes | yes | yes | n/a |
| Raise hand | no | no | no | yes |
| Promote to speaker | yes | yes | no | no |
| Demote to listener | yes | yes (not host) | no | no |
| Mute others | yes | yes (not host) | no | no |
| Kick participant | yes | yes (not host) | no | no |
| Ban participant | yes | yes (not host) | no | no |
| Set co-host | yes | no | no | no |
| End space | yes | yes | no | no |
| Start/stop recording | yes | yes | no | no |

### Enforcement

Permissions are enforced at TWO levels:

1. **Backend API** — Every permission-changing endpoint checks the caller's role in the room before executing. This is the source of truth. Never trust the client.

2. **LiveKit grants** — The `can_publish` grant on the LiveKit token controls whether a participant can send audio. Listeners get `can_publish: false`. When promoted, a new token is issued with `can_publish: true` and the client reconnects (or we use `updateParticipant` to change permissions live).

### Promotion flow (detailed)

```
1. Listener raises hand
   → Client: POST /v1/rooms/:id/raise-hand { raised: true }
   → Backend: Sets hand_raised in Redis, adds to hand_queue LIST
   → Backend: Publishes "hand_raised" event on Redis pub/sub
   → Client (host): Receives event, shows hand in UI

2. Host accepts hand
   → Client (host): POST /v1/rooms/:id/participants/:fid/promote
   → Backend: Validates host role
   → Backend: Calls LiveKit updateParticipant(can_publish: true)
   → Backend: Updates Redis participant role to "speaker"
   → Backend: Removes from hand_queue
   → Backend: Publishes "role_changed" event
   → Client (promoted user): Receives event, UI updates to speaker view
   → Client (promoted user): Calls localParticipant.setMicrophoneEnabled(true)

3. Promoted user speaks
   → LiveKit handles all audio transport
   → Speaker can self-mute/unmute via local track control
```

### Demotion flow

```
1. Host demotes speaker
   → Client (host): POST /v1/rooms/:id/participants/:fid/demote
   → Backend: Validates host/co_host role
   → Backend: Calls LiveKit updateParticipant(can_publish: false)
   → Backend: Updates Redis participant role to "listener"
   → Backend: Publishes "role_changed" event
   → Client (demoted user): LiveKit auto-unpublishes tracks
   → Client (demoted user): UI reverts to listener view
```

---

## 12. Room discovery & lifecycle

### Discovery sources

1. **In-app spaces rail** — Primary. `GET /v1/rooms?status=active` polled every 15s. Sorted by listener_count descending.

2. **Farcaster cast** — When host creates a room with `announce_cast: true`, a cast is published containing a link to the space. Users on any Farcaster client see the cast. Clicking the link opens the app (via deep link) or web fallback.

### Room lifecycle

```
Created → Active → Ended
                ↗
           Cancelled (if host ends before anyone joins)
```

**Creation:**
1. Host taps `+`, enters title
2. `POST /v1/rooms` creates Postgres row + LiveKit room + Redis state
3. Host auto-joins as first participant
4. Optional announcement cast sent via Neynar

**Active:**
- Participants join/leave freely
- LiveKit handles audio transport
- Redis maintains real-time state
- Backend processes permission changes

**Ended:**
- Host (or co-host) ends the space
- All participants disconnected from LiveKit
- Redis state cleared
- Postgres row updated with `ended_at`
- If recording was active, egress finishes and URL stored

**Auto-cleanup:**
- LiveKit `empty_timeout: 300` — room auto-closes 5 min after last participant leaves
- Backend receives `room_finished` webhook, updates Postgres
- Cron job (or scheduled task) cleans stale Redis keys daily

### Deep linking

URL scheme: `APPNAME://space/{room_id}`

Universal link: `https://APPNAME.xyz/space/{room_id}`

When opened:
- If app installed: opens directly to space screen
- If not installed: web fallback page with App Store link
- If space is ended: show "This space has ended" message

---

## 13. Reconnection engine

### Triggers

The reconnection engine activates when:

1. **Network transition** — WiFi to cellular, cellular to WiFi
2. **Wake from sleep** — Screen was locked, app was backgrounded
3. **LiveKit disconnected event** — Server-side disconnect
4. **Token expiry approaching** — Token will expire in < `TOKEN_REFRESH_BUFFER_SEC`

### Strategy

```typescript
// hooks/useReconnect.ts

interface ReconnectConfig {
  maxAttempts: number;       // 5
  baseDelayMs: number;       // 1000
  maxDelayMs: number;        // 30000
  tokenRefreshBufferSec: number; // 300
}

class ReconnectionEngine {
  private attempts = 0;
  private roomId: string;
  private token: string;
  private tokenExpiresAt: number;

  async onDisconnected(reason: DisconnectReason) {
    // Don't reconnect if user intentionally left
    if (reason === 'user_left' || reason === 'kicked') return;

    while (this.attempts < this.config.maxAttempts) {
      const delay = Math.min(
        this.config.baseDelayMs * Math.pow(2, this.attempts),
        this.config.maxDelayMs,
      );
      await sleep(delay);

      try {
        // 1. Refresh token if needed
        if (this.isTokenExpiringSoon()) {
          const { livekit_token } = await api.refreshRoomToken(this.roomId);
          this.token = livekit_token;
        }

        // 2. Check if room still exists
        const room = await api.getRoom(this.roomId);
        if (room.status !== 'active') {
          // Room ended while we were disconnected
          this.handleRoomEnded();
          return;
        }

        // 3. Reconnect to LiveKit
        await this.room.connect(wsUrl, this.token);

        // 4. Restore state
        await this.restoreParticipantState();

        this.attempts = 0;
        return;

      } catch (err) {
        this.attempts++;
      }
    }

    // Max attempts reached
    this.handleReconnectFailed();
  }

  private isTokenExpiringSoon(): boolean {
    const now = Date.now() / 1000;
    return (this.tokenExpiresAt - now) < this.config.tokenRefreshBufferSec;
  }

  private async restoreParticipantState() {
    // Re-fetch room state from backend
    const { participants, room } = await api.getRoom(this.roomId);

    // Find our participant record
    const me = participants.find(p => p.fid === myFid);
    if (!me) {
      // We were kicked while disconnected
      this.handleKicked();
      return;
    }

    // Restore role and mute state
    spaceStore.setState({
      my_role: me.role,
      participants,
      room,
    });

    // If we were a speaker, re-enable microphone
    if (me.role === 'speaker' || me.role === 'host' || me.role === 'co_host') {
      await this.room.localParticipant?.setMicrophoneEnabled(!me.is_muted);
    }
  }
}
```

### Token lifecycle

- LiveKit tokens are issued with 6-hour TTL
- Client tracks expiry time from JWT decode
- At `T - 5min`, client calls `POST /v1/rooms/:id/token` for a fresh token
- LiveKit SDK supports token refresh via `room.token = newToken` without full reconnect

### Grace period

When a participant disconnects (network drop, not intentional leave):

- Backend does NOT immediately remove them from the room
- LiveKit has a built-in reconnection window (~30s)
- Backend waits for the `participant_left` webhook from LiveKit (fires after LiveKit's own timeout)
- If the participant reconnects within the window, their state is preserved
- If they don't, backend cleans up: removes from Redis, updates Postgres `left_at`

---

## 14. Recording (v1.1)

### Architecture

LiveKit's Egress service handles recording. For cloud customers, it's available without additional infra.

**Flow:**
1. Host taps "Start recording" in host controls
2. Client calls `POST /v1/rooms/:id/recording/start`
3. Backend calls LiveKit `StartRoomCompositeEgress` (audio-only mode)
4. LiveKit spins up egress worker, joins room as invisible participant, mixes all audio
5. Mixed audio streams to S3 as OGG file
6. When host stops recording (or room ends), backend calls `StopEgress`
7. LiveKit sends `egress_ended` webhook with file URL
8. Backend stores URL in Postgres `rooms.recording_url`

### Backend endpoints

```python
# POST /v1/rooms/:room_id/recording/start
async def start_recording(room_id: str):
    # Validate: caller is host/co_host, recording not already active
    output = api.EncodedFileOutput(
        file_type=api.EncodedFileType.OGG,
        filepath=f"recordings/{room_id}/{datetime.now().isoformat()}.ogg",
        s3=api.S3Upload(
            bucket=settings.S3_BUCKET,
            region=settings.S3_REGION,
            access_key=settings.S3_ACCESS_KEY,
            secret=settings.S3_SECRET_KEY,
        ),
    )

    egress_info = await livekit_api.egress.start_room_composite_egress(
        api.RoomCompositeEgressRequest(
            room_name=room_id,
            audio_only=True,
            file_outputs=[output],
        )
    )

    # Store egress_id for later stop
    await redis.set(f"room:{room_id}:egress_id", egress_info.egress_id)
    return {"egress_id": egress_info.egress_id, "status": "recording"}

# POST /v1/rooms/:room_id/recording/stop
async def stop_recording(room_id: str):
    egress_id = await redis.get(f"room:{room_id}:egress_id")
    await livekit_api.egress.stop_egress(api.StopEgressRequest(egress_id=egress_id))
    return {"status": "stopping"}
```

### Cost estimate

- Audio-only egress: $0.004/minute on LiveKit Cloud
- 1-hour space recording: $0.24
- Storage: ~30MB per hour (OGG), pennies on S3
- Self-host breakpoint: ~200 recorded hours/month ($48/mo droplet vs $48/mo cloud)

---

## 15. Infrastructure & deployment

### DigitalOcean setup

```
Region: SFO3 (or closest to majority of users)

Backend:
  - Droplet: s-2vcpu-4gb ($24/mo)
  - Ubuntu 24.04 LTS
  - Docker + docker-compose
  - Nginx reverse proxy with Let's Encrypt
  - Scale to s-4vcpu-8gb ($48/mo) at growth stage

Database:
  - DO Managed PostgreSQL
  - db-s-1vcpu-1gb ($15/mo)
  - Automatic backups enabled
  - Private networking to backend

Redis:
  - Upstash Serverless Redis ($10/mo pro plan)
    OR
  - DO Managed Redis db-s-1vcpu-1gb ($15/mo)
  - Upstash preferred for lower latency + pay-per-use at low scale
```

### Docker compose (local development)

```yaml
version: '3.8'

services:
  api:
    build: .
    ports:
      - "8000:8000"
    env_file: .env
    depends_on:
      - postgres
      - redis
    volumes:
      - ./app:/app
    command: uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: dev
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: farcaster_audio
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

volumes:
  pgdata:
```

### Production deployment

```
DNS:
  api.APPNAME.xyz → DO droplet IP (A record)
  APPNAME.xyz → Vercel/Cloudflare (web fallback page)

SSL:
  Let's Encrypt via Certbot + Nginx

Nginx config:
  /v1/* → proxy_pass http://127.0.0.1:8000
  WebSocket upgrade for /v1/ws/* (if adding WebSocket later)

Process manager:
  gunicorn with uvicorn workers
  Workers: 4 (2x vCPU)
  Timeout: 120s (increased for WebRTC token operations)
  NOTE: Do NOT use bcrypt for password hashing on small vCPUs
        (learned the hard way — use argon2id instead if any hashing needed)

Monitoring:
  - DO built-in monitoring (CPU, memory, disk)
  - Sentry for error tracking (free tier)
  - Simple /health endpoint for uptime monitoring
```

### CI/CD

```
Backend:
  GitHub Actions:
    on push to main:
      1. Run tests (pytest)
      2. Build Docker image
      3. Push to DO Container Registry
      4. SSH to droplet, pull + restart

Mobile:
  EAS Build:
    eas build --platform ios --profile preview   # TestFlight
    eas build --platform ios --profile production # App Store
    eas submit --platform ios                     # Submit to App Store Connect
```

---

## 16. Development workflow

### Tools

- **Claude Code** — Primary development agent, with Expo MCP server connected
- **Expo MCP Server** — Connected via `claude mcp add --transport http expo https://mcp.expo.dev`
  - Provides: latest Expo docs, package management, simulator screenshots, UI interaction testing
  - Requires: Expo SDK 55, EAS account, personal access token
- **Expo Dev Client** — Custom dev build (not Expo Go, since we have native modules)
- **TestFlight** — Beta distribution

### Agent development workflow

```
1. Agent creates/modifies code
2. Agent runs `npx expo start` (dev server)
3. Agent uses Expo MCP to:
   a. Take simulator screenshot to verify UI
   b. Tap UI elements to test interactions
   c. Read console logs for errors
4. Agent iterates until screen matches spec
5. Agent runs tests
6. Agent commits + pushes
```

### Key dependencies to install

```bash
# Expo + navigation
npx create-expo-app@latest --template default@sdk-55
npx expo install expo-router expo-secure-store expo-linking expo-web-browser

# LiveKit
npx expo install @livekit/react-native @livekit/react-native-webrtc

# Neynar SIWN
npm install @neynar/react-native-signin

# State + networking
npm install zustand axios

# UI
npx expo install expo-image  # fast image loading for avatars
npm install react-native-safe-area-context

# Development
npm install -D @types/react @types/react-native typescript
```

### Backend dependencies

```
# requirements.txt
fastapi>=0.115.0
uvicorn[standard]>=0.30.0
gunicorn>=22.0.0
pydantic>=2.0
pydantic-settings>=2.0
sqlalchemy[asyncio]>=2.0
asyncpg>=0.29.0
alembic>=1.13.0
redis[hiredis]>=5.0
livekit-api>=0.7.0
python-jose[cryptography]>=3.3.0
httpx>=0.27.0
python-multipart>=0.0.9
sentry-sdk[fastapi]>=2.0
```

---

## 17. Testing strategy

### Mobile — Unit tests

```typescript
// Use Jest + React Native Testing Library
// Focus on:
// - Store logic (Zustand stores)
// - Permission checks (useSpacePermissions)
// - Reconnection engine logic
// - API client response mapping

// Do NOT unit test:
// - LiveKit audio (integration test territory)
// - Native module behavior (physical device only)
// - Navigation flows (E2E)
```

### Mobile — Manual test matrix (physical device required)

| Scenario | Steps | Expected |
|---|---|---|
| Background audio | Join space → lock screen → wait 60s | Audio continues uninterrupted |
| App switch | Join space → open Safari → wait 30s → return | Audio continues, UI reconnects |
| Bluetooth | Connect AirPods → join space → disconnect AirPods | Audio routes to speaker, no crash |
| Phone call | In space → receive phone call → end call | Audio resumes after call |
| WiFi → cellular | In space → disable WiFi | Brief pause, auto-reconnect |
| Token refresh | In space → wait until near token expiry | Seamless token refresh, no audio drop |
| Kill app | In space → force quit app → reopen | Shows "rejoin" prompt or clean state |
| Memory pressure | In space → open many other apps | Audio should survive unless iOS kills process |
| Host kick | In space as listener → host kicks you | Clean disconnect, return to feed |
| Promote/demote | Listener → raise hand → get promoted → speak → get demoted | All transitions smooth |

### Backend — Unit + integration tests

```python
# pytest + httpx AsyncClient
# Use testcontainers for Postgres + Redis in CI

# Test coverage targets:
# - All API endpoints (happy path + error cases)
# - Permission enforcement (every role × every action)
# - Room lifecycle (create → join → leave → end)
# - Ban enforcement
# - Token generation correctness
# - Webhook handling
# - Reconnection token refresh
```

---

## 18. Security considerations

### Authentication

- JWT tokens with HS256, 72-hour expiry
- Refresh tokens stored in `expo-secure-store` (iOS Keychain)
- SIWF verification via Neynar API (never trust client-provided FID without verification)
- All API endpoints require valid JWT except: `/v1/auth/login`, `/health`

### Authorization

- Every permission-modifying action validated server-side against role hierarchy
- LiveKit tokens scoped to specific room with role-appropriate grants
- Listeners get `can_publish: false` — even if client is modified, they cannot publish audio

### Data

- No sensitive data stored locally beyond JWT + refresh token
- Farcaster data (casts, profiles) fetched on-demand from Neynar, not cached in our DB
- Room recordings stored in S3 with private ACL, served via signed URLs

### Rate limiting

- Backend: 100 requests/minute per user (token bucket)
- Room creation: 5 rooms/hour per user
- Hand raise: 10 raises/minute per user (prevent spam)
- LiveKit Cloud: Built-in DDoS protection on WebRTC transport

### WebRTC security

- LiveKit Cloud handles DTLS-SRTP encryption for all audio
- No direct peer-to-peer — all traffic routed through SFU
- Participant identity bound to FID in token — cannot be spoofed

---

## 19. Cost model

### MVP (month 1-2, <50 DAU)

| Service | Monthly cost |
|---|---|
| Neynar Growth | $99 |
| LiveKit Cloud (~500 participant-hours) | $60-80 |
| DO Droplet (s-2vcpu-4gb) | $24 |
| DO Managed Postgres | $15 |
| Upstash Redis (Pro) | $10 |
| Apple Developer (annualized) | $8 |
| **Total** | **~$220-240** |

### Growth (month 3-6, ~500 DAU)

| Service | Monthly cost |
|---|---|
| Neynar Growth | $99 |
| LiveKit Cloud (~2,000 participant-hours) | $160-240 |
| Recording egress (~200 hours) | $48 |
| S3 storage (~60GB) | $5 |
| DO Droplet (s-4vcpu-8gb) | $48 |
| DO Managed Postgres | $15 |
| Upstash Redis | $10 |
| Apple Developer | $8 |
| Sentry (free tier) | $0 |
| **Total** | **~$400-475** |

### Scale inflection (>1,000 participant-hours/month)

At this point, self-hosting LiveKit on a dedicated droplet ($96/mo for 8-CPU) saves significant money vs cloud pricing. The open-source license makes this straightforward.

---

## 20. Build phases & milestones

### Phase 1: Foundation (Week 1)

**Deliverables:**
- [ ] Expo project initialized with SDK 55, bare workflow
- [ ] Expo Router navigation structure (login, home, space/[id], space/create)
- [ ] Neynar SIWF auth flow working end-to-end
- [ ] JWT auth on backend, `/v1/auth/login` and `/v1/auth/refresh`
- [ ] Zustand auth store with secure storage persistence
- [ ] Backend project scaffolded (FastAPI + SQLAlchemy + Alembic)
- [ ] Database migrations applied (users, rooms, participants, bans)
- [ ] Docker compose for local dev
- [ ] Basic CI (lint + type check)

**Exit criteria:** User can sign in with Farcaster and see a blank home screen with their profile loaded.

### Phase 2: Feed (Week 2)

**Deliverables:**
- [ ] FeedList component with virtualized scrolling
- [ ] CastCard component rendering text casts
- [ ] CastActions with like and recast (calling Neynar API)
- [ ] Pull-to-refresh and infinite scroll pagination
- [ ] SpacesRail component (static, no live data yet — placeholder avatars)
- [ ] Avatar component with Farcaster PFP + fallback initials

**Exit criteria:** User sees their following feed, can like and recast. Spaces rail renders with placeholder data.

### Phase 3: Audio MVP (Week 3)

**Deliverables:**
- [ ] Backend room CRUD endpoints (`POST /v1/rooms`, `GET /v1/rooms`, `DELETE /v1/rooms/:id`)
- [ ] LiveKit server SDK integration (room creation, token generation)
- [ ] `POST /v1/rooms/:id/join` and `POST /v1/rooms/:id/leave`
- [ ] `@livekit/react-native` integrated in the app
- [ ] Basic space screen: connect to room, hear audio, see participant list
- [ ] Microphone publish (for host — hardcoded role for now)
- [ ] Redis room state management
- [ ] SpacesRail connected to `GET /v1/rooms` (live data)

**Exit criteria:** Host can create a space, another user can join and hear the host. Both see each other in the participant list. Spaces appear in the rail.

### Phase 4: Spaces UI + permissions (Week 4)

**Deliverables:**
- [ ] Full permission model implemented (host, co_host, speaker, listener)
- [ ] SpeakerGrid and ListenerList components
- [ ] HandRaiseButton + raise hand flow
- [ ] HostControls panel (mute, kick, ban, promote, demote, end space)
- [ ] SpaceMiniBar (persistent across screens)
- [ ] Self mute/unmute for speakers
- [ ] Redis pub/sub for real-time participant updates
- [ ] Backend ban enforcement on join
- [ ] Announcement cast on room creation (via Neynar)
- [ ] Deep linking: `APPNAME://space/{room_id}`

**Exit criteria:** Full X Spaces-like experience works in foreground. Host can manage speakers, listeners can raise hands, all permission checks enforced.

### Phase 5: Background audio (Week 5 — danger zone)

**Deliverables:**
- [ ] Swift native module: `AudioSessionModule`
- [ ] `AVAudioSession` configured for `.playAndRecord` + `.voiceChat`
- [ ] `UIBackgroundModes: audio` verified working on physical device
- [ ] Audio persists through: screen lock, app switch, control center
- [ ] Audio interruption handling (phone calls, Siri)
- [ ] Audio route change handling (Bluetooth connect/disconnect)
- [ ] Reconnection engine: exponential backoff, token refresh, state restore
- [ ] Grace period on disconnect (don't remove participant immediately)

**Exit criteria:** User can join a space, lock their phone, walk around for 10 minutes, unlock, and audio never dropped. Bluetooth and phone call interruptions handled gracefully.

### Phase 6: Polish + TestFlight (Week 6)

**Deliverables:**
- [ ] Edge case fixes from Phase 5 testing
- [ ] WiFi → cellular handoff testing + fixes
- [ ] Loading states, error states, empty states for all screens
- [ ] App icon, splash screen, app name
- [ ] EAS Build configuration (preview + production profiles)
- [ ] TestFlight submission via EAS Submit
- [ ] Backend deployed to DO production
- [ ] DNS + SSL configured
- [ ] Sentry error tracking integrated
- [ ] Recording endpoint wired (backend only, UI toggle stretch goal)

**Exit criteria:** App accepted on TestFlight, 5+ beta testers can use spaces simultaneously with persistent background audio.

---

## Appendix A: Key risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| iOS background audio unreliable on certain devices | Medium | Critical | Test on iPhone 12+, 14+, 16; file Apple DTS if needed |
| Neynar SIWN SDK RN compatibility with Expo 55 | Low | Low | SDK confirmed available (`@neynar/react-native-signin`); test early in week 1 |
| LiveKit RN SDK bugs with background mode | Low | High | Fallback: fork SDK, patch AVAudioSession handling |
| App Store rejection (background audio justification) | Medium | High | Clear description of audio spaces use case in review notes |
| LiveKit Cloud latency in certain regions | Low | Medium | LiveKit has global edge, but can self-host if needed |

## Appendix B: Future considerations (post-MVP)

- **Android** — Foreground service + notification for background audio
- **Recording playback** — In-app audio player for past spaces
- **Scheduled spaces** — Create a space with a future start time, auto-notify followers
- **Co-hosting** — Multiple hosts with shared control (partially built in permission model)
- **Transcription** — LiveKit has STT egress, could auto-transcribe spaces
- **Clips** — Let listeners clip last 30s of audio (requires circular buffer)
- **Frames** — Farcaster Frame for space cards in-feed (join directly from Warpcast)
- **Token gating** — Require holding a specific token to join certain spaces
- **Tipping** — In-space tipping via x402 or on-chain tips (natural Farcaster integration)
