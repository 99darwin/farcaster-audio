# Juke — Farcaster Audio Client

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Open-source Farcaster client with built-in audio spaces. A reference implementation other developers can fork for Farcaster + LiveKit-based audio projects.

## What's in the box

Three apps in one repo:

```
farcaster-audio-client/
├── backend/           FastAPI + Postgres + Redis  -> REST + WebSocket API
├── farcaster-audio/   Expo SDK 55 (React Native)  -> iOS client (MVP)
└── landing/           Next.js 15 App Router       -> juke.audio marketing + miniapp
```

- **`backend/`** — FastAPI service. Owns auth (JWT + SIWF/Quick Auth), audio room lifecycle, LiveKit token issuance, Farcaster feed proxying via Neynar, miniapp webhooks, and recording orchestration.
- **`farcaster-audio/`** — Expo bare workflow iOS client. Joins/hosts audio rooms while browsing the Farcaster feed. LiveKit WebRTC, Neynar SIWN auth, push notifications.
- **`landing/`** — Next.js public site at juke.audio. Renders the Farcaster miniapp surface, marketing pages, and OG-image generation.

See [`CLAUDE.md`](./CLAUDE.md) for the agent-facing project config.

## Prerequisites

- Node 20+
- Python 3.12
- PostgreSQL 16
- Redis 7
- Docker (for the backend stack)
- A [LiveKit](https://livekit.io/) account (cloud or self-hosted)
- A [Neynar](https://neynar.com/) API key

Recommended but optional:

- [Cloudinary](https://cloudinary.com/), [Giphy](https://developers.giphy.com/), [Deepgram](https://deepgram.com/), AWS S3-compatible storage, and [Sentry](https://sentry.io/) — see "What's intentionally external" below.

## Local development quick-start

Each app has its own `.env.example`. Copy it to `.env`, fill in your own credentials, then start the app.

### `backend/`

```bash
cd backend
cp .env.example .env          # then fill in DATABASE_URL, REDIS_URL, JWT_SECRET, etc.
docker-compose up             # boots Postgres 16, Redis 7, and the API
```

The API listens on `http://localhost:8000`. OpenAPI docs at `http://localhost:8000/docs`.

Run migrations against a fresh DB:

```bash
cd backend
alembic upgrade head
```

### `farcaster-audio/`

```bash
cd farcaster-audio
cp .env.example .env          # then fill in EXPO_PUBLIC_* values
npm install
cd ios && pod install && cd ..
npx expo start                # then press `i` to launch the iOS simulator
```

iOS-only MVP. You need Xcode + an iOS simulator (or a paired device with a development build).

### `landing/`

```bash
cd landing
cp .env.example .env          # fill in any required NEXT_PUBLIC_* values
npm install
npm run dev
```

Visit `http://localhost:3000`.

## What's intentionally external

Juke integrates with several third-party services. Operators bring their own credentials; the repo never ships shared keys.

| Service     | Used for                                                              |
|-------------|-----------------------------------------------------------------------|
| LiveKit     | Real-time audio SFU. Required.                                        |
| Neynar      | Farcaster auth (SIWN), feed, reactions, social graph, webhooks. Required. |
| Cloudinary  | Image hosting + transforms for casts and avatars.                     |
| Giphy       | GIF search in cast composer.                                          |
| Deepgram    | Speech-to-text transcription for recorded rooms.                      |
| AWS S3      | Recording storage (S3-compatible endpoints supported).                |
| Sentry      | Optional error monitoring (mobile + backend).                         |

If you fork Juke for a different audio-social product, swap these out at the service layer in `backend/app/services/`.

## Testing

```bash
# Backend (pytest + httpx + testcontainers)
cd backend && pytest

# Mobile (jest + react-native testing library)
cd farcaster-audio && npx jest

# Landing (Next.js build is the smoke test)
cd landing && npm run build
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch naming, commit style, and per-app test/lint commands.

## Security

See [SECURITY.md](./SECURITY.md) for the disclosure process and reporting contact.

## License

MIT — see [LICENSE](./LICENSE).
