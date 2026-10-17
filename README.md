# Juke — Farcaster Audio Client

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Open-source Farcaster client with live audio spaces. Browse your feed, join or host a space, and keep listening while you scroll, post, react and reply. Juke runs on iOS, Android and the web, and is meant as a reference implementation you can fork for Farcaster + LiveKit audio projects.

## What's in the box

```
farcaster-audio/
├── backend/           FastAPI + Postgres + Redis    -> REST + WebSocket API
├── farcaster-audio/   Expo SDK 55 (React Native)    -> iOS + Android app
└── landing/           Next.js 15 App Router         -> landing site + web client
```

- **`backend/`**: FastAPI service. Owns sessions (JWT, Sign in with Farcaster, Protocol Auth), audio room lifecycle and LiveKit token issuance, Farcaster reads and writes through Hypersnap, on-chain signer registration via the KeyGateway relayer, the Direct Casts proxy, push notifications, the developer API, and recording orchestration (`backend/recording_agent/` is the Node recording worker).
- **`farcaster-audio/`**: Expo bare-workflow app for iOS and Android. Feed, compose, notifications, search, Direct Casts, and LiveKit audio spaces that keep playing while you browse.
- **`landing/`**: Next.js site. Marketing pages, the full web client (feed, spaces, messaging), the Farcaster mini app surface, embeds, and OG-image generation.

### Highlights

- **No Neynar dependency.** Farcaster data comes from [Hypersnap](https://haatz.quilibrium.com), an open Farcaster node. Writes are protobuf messages signed with the user's own on-chain signer. (An optional Neynar key only powers mini app search.)
- **On-chain signers.** Users authorize Juke once through the Farcaster KeyGateway contract on Optimism; the backend relays the transaction and pays gas. See the recovery phrase section below.
- **Direct Casts.** Your real Farcaster DMs inside Juke on mobile and web, interoperable with every other Farcaster client.
- **LiveKit spaces.** Host, speak, raise hands, listen anonymously on the web, record, and embed spaces in third-party sites.

See [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md) for the agent-facing project config.

## Why Juke asks for your recovery phrase

Juke runs on open Farcaster infrastructure (Hypersnap). It doesn't depend on Neynar or the Farcaster client's sign-in relay. Without that relay, the only way to authorize Juke to post as you is for your own account to approve it on-chain. Your recovery phrase is how you give that approval, and you do it once.

### How it works

- **It stays on your device.** Your phrase is never stored, logged or sent to Juke or anyone else. Only signatures leave your phone.
- **It's used once, then discarded.** The phrase signs up to four things on your device, then the app drops it:
  1. Two KeyGateway approvals, which add Juke's posting key and your device's login key to your account
  2. A short-lived sign-in token
  3. Optionally, a token that turns on Direct Casts
- **Your phone checks every request first.** Your phone only signs requests that add Juke's posting key and your device key to your own account, through the official Farcaster KeyGateway contract on Optimism. A request to transfer your account, or to sign for any other purpose, is refused and nothing is signed. This holds even if Juke's servers were compromised.
- **After that, no phrase.** Your device signs in with its own key, so you won't be asked again on that device.
- **Juke pays the gas.**

### What Juke holds

- **An encrypted posting key.** It can post, react, follow and update your profile as you until you revoke it. It can't move or recover your account. You can revoke it at any time from your Farcaster account's connected apps.
- **If you turn on Direct Casts, an encrypted messaging token.** It's deleted when you sign out, and expires on its own after at most 90 days.

### What it enables

- **Posting from Juke:** casts, threads, replies, voice notes, likes, recasts and follows, with no third party in between.
- **Direct Casts:** your real Farcaster DMs inside Juke, working with every other Farcaster client. Farcaster's DM service only accepts a token signed by your account's root key, which is why messaging needs the phrase.
- **No middleman:** the app holds no provider API keys, and your account's permissions live on-chain, where you control them.

**Use your Farcaster recovery phrase, not your Farcaster wallet phrase.**

The signing code is in [`farcaster-audio/services/signerLink.ts`](farcaster-audio/services/signerLink.ts) (mobile) and [`landing/lib/auth/protocolLogin.ts`](landing/lib/auth/protocolLogin.ts) (web).

## Security hardening

The current release includes a broad hardening pass across all three apps: an enforced per-request-nonce Content Security Policy on the web, fail-closed framing rules for embeds, server-side verification of Farcaster mini app webhook signatures, rate limits and connection caps keyed on a trusted client IP, encrypted-at-rest signer keys with key rotation support, secret redaction in logs and Sentry events, and production startup checks that refuse weak or missing secrets. Please report anything you find through [SECURITY.md](./SECURITY.md) rather than a public issue.

## Prerequisites

- Node 20+
- Python 3.12
- Docker (for local Postgres 16 and Redis 7)
- A [LiveKit](https://livekit.io/) project (cloud or self-hosted)
- A Hypersnap node URL (the public node is the default)
- For posting and signer registration: an Optimism RPC URL and a funded relayer wallet
- For mobile builds: Xcode (iOS) and/or Android Studio, plus an [EAS](https://expo.dev/eas) project of your own

Optional: S3-compatible storage (recordings, voice notes), Deepgram (transcription), Cloudinary (image uploads), Giphy (GIF search), Sentry (error monitoring), Firebase (Android push via FCM).

## Self-hosting quick-start

Each app has its own `.env.example`. Copy it to `.env` and fill in your own values. Never commit `.env` files.

### `backend/`

```bash
cd backend
cp .env.example .env              # fill in your values (see keys below)
docker-compose up -d              # Postgres 16 + Redis 7
python3.12 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload     # http://localhost:8000, docs at /docs
```

Core environment keys (the full, commented list is `backend/app/config.py`):

| Area | Keys |
|------|------|
| Core | `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `ENVIRONMENT`, `CORS_ORIGINS`, `API_BASE_URL`, `LOG_LEVEL`, `ADMIN_SECRET` |
| Sign-in | `SIWF_DOMAIN`, `QUICKAUTH_ALLOWED_AUDIENCES` (empty disables the matching login path) |
| Audio | `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_WS_URL` |
| Farcaster | `HYPERSNAP_HTTP_URL`, `FARCASTER_APP_MNEMONIC`, `FARCASTER_APP_FID`, `HYPERSNAP_WEBHOOK_SECRET_*` |
| Signers | `OPTIMISM_RPC_URL`, `KEY_RELAYER_PRIVATE_KEY`, `SIGNER_ENCRYPTION_KEY`, `SIGNER_ENCRYPTION_KEYS` |
| Messaging | `MESSAGING_ENABLED` |
| Developer API | `JUKE_API_KEY_PEPPER`, `JUKE_API_KEY_ENCRYPTION_KEY`, `JUKE_API_AUDIT_SECRET`, `JUKE_BOT_SIGNER_ENCRYPTION_KEY` |
| Storage / media | `AWS_S3_BUCKET_NAME`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL`, `DEEPGRAM_API_KEY`, `CLOUDINARY_*`, `GIPHY_API_KEY` |
| Mini app | `MINIAPP_WEBHOOK_SECRET` |
| Network edge | `TRUSTED_PROXY_IPS` (see [`docs/backend-network-limits.md`](docs/backend-network-limits.md)) |

In non-development environments the API refuses to start with missing or weak secrets.

### `farcaster-audio/`

```bash
cd farcaster-audio
cp .env.example .env              # EXPO_PUBLIC_* values
npm install
npx expo run:ios                  # or: npx expo run:android
```

Mobile keys: `EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_WEB_BASE_URL`, `EXPO_PUBLIC_LIVEKIT_WS_URL`, `EXPO_PUBLIC_HYPERSNAP_HTTP_URL`, `EXPO_PUBLIC_EAS_PROJECT_ID`, `EXPO_PUBLIC_SENTRY_DSN`. Every `EXPO_PUBLIC_*` value is bundled into the app, so never put a secret in one.

Before shipping your own build, set your own bundle identifier, EAS project (`eas init`), Apple team and submit credentials. Android push needs your own `google-services.json`; see [`farcaster-audio/README.md`](farcaster-audio/README.md).

### `landing/`

```bash
cd landing
cp .env.example .env
npm install
npm run dev                       # http://localhost:3000
```

Web keys: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_HYPERSNAP_HTTP_URL`, `NEXT_PUBLIC_PROTOCOL_AUTH_DOMAIN`, `NEXT_PUBLIC_PROTOCOL_AUTH_URI`, `NEXT_PUBLIC_MESSAGING_ENABLED`, `NEXT_PUBLIC_APP_DOWNLOAD_URL`, `NEXT_PUBLIC_ANDROID_DOWNLOAD_URL`, plus the server-only `API_BASE_URL` and `MINIAPP_WEBHOOK_SECRET`. If you serve uploads from your own object storage, add its origin to `THIRD_PARTY_CONNECT_SOURCES` in `landing/lib/security/csp.ts`. Universal Links need your Apple Team ID and bundle ID in `landing/public/.well-known/apple-app-site-association`.

## Testing

```bash
cd backend && pytest                       # pytest + httpx; some suites use testcontainers
cd farcaster-audio && npx tsc --noEmit && npx jest
cd landing && npx tsc --noEmit && npx jest && npm run build
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch naming, commit style, and per-app test/lint commands.

## Security

See [SECURITY.md](./SECURITY.md) for the disclosure process and reporting contact.

## License

MIT — see [LICENSE](./LICENSE).
