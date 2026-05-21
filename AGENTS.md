# Farcaster Audio Client — Codex Project Config

## Project Overview

Farcaster Audio Spaces Client is an iOS app combining the Farcaster social feed with persistent audio spaces (like Twitter/X Spaces). Users can join and host live audio rooms while browsing their Farcaster feed, reacting, and interacting socially. MVP is iOS only.

## Architecture Summary

- **Frontend**: Expo SDK 55 bare workflow (React Native, iOS-only MVP)
- **Landing**: Next.js (App Router) at juke.audio — Tailwind CSS + Framer Motion
- **Backend**: FastAPI (Python) serving a REST + WebSocket API
- **Database**: PostgreSQL 16 (via SQLAlchemy + Alembic)
- **Cache / Pub-Sub**: Redis 7
- **Audio**: LiveKit (SFU-based real-time audio)
- **Farcaster Integration**: Neynar (auth, feed, reactions, social graph)

## Tech Stack

| Layer         | Technology                  | Version   |
|---------------|-----------------------------|-----------|
| Mobile        | React Native (Expo)         | SDK 55    |
| Landing       | Next.js (App Router)        | 15        |
| Language      | TypeScript                  | strict    |
| Backend       | FastAPI                     | latest    |
| Language      | Python                      | 3.12      |
| ORM           | SQLAlchemy                  | 2.x       |
| Migrations    | Alembic                     | latest    |
| Database      | PostgreSQL                  | 16        |
| Cache         | Redis                       | 7         |
| Audio         | LiveKit                     | latest    |
| Farcaster     | Neynar                      | v2 API    |
| Auth          | JWT (access + refresh)      | —         |

## Directory Structure

```
farcaster-audio-client/
├── AGENTS.md                       # This file
├── backend/                        # FastAPI backend
│   ├── app/
│   │   ├── api/                    # Route handlers
│   │   ├── models/                 # SQLAlchemy models
│   │   ├── schemas/                # Pydantic schemas
│   │   ├── services/               # Business logic
│   │   │   └── room_service.py     # Core orchestrator for audio rooms
│   │   └── core/                   # Config, auth, dependencies
│   ├── alembic/                    # Database migrations
│   ├── tests/                      # pytest test suite
│   ├── docker-compose.yml          # Postgres, Redis, API
│   └── pyproject.toml
├── landing/                        # Next.js landing page (juke.audio)
│   ├── app/                        # App Router pages + layout
│   └── public/                     # OG image, logo assets
└── farcaster-audio/                # Expo bare workflow app
    ├── app/                        # Expo Router screens
    ├── components/                 # Shared UI components
    ├── hooks/
    │   └── useSpace.ts             # Central frontend hook for audio spaces
    ├── services/                   # API clients and integrations
    ├── store/                      # State management
    └── package.json
```

## Dev Commands

```bash
# Start Postgres, Redis, and API server
cd backend && docker-compose up

# Start Expo dev server (iOS)
cd farcaster-audio && npx expo start

# Run backend tests
cd backend && pytest

# Run database migrations
cd backend && alembic upgrade head

# Start landing page dev server
cd landing && npm run dev

# Run frontend tests
cd farcaster-audio && npx jest
```

## Conventions

### Git
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
- Feature branches: `feat/`, `fix/`, `chore/`
- Never commit directly to `main`

### Frontend (TypeScript)
- TypeScript strict mode enabled
- ESLint + Prettier for formatting
- `const` over `let`; never `var`
- Named exports preferred over default exports

### Backend (Python)
- Black formatting, 88-character line length
- PEP 8 compliant
- `async`/`await` for all I/O
- Pydantic for request/response schemas

## Environment Variables

Never commit values. Keys only are listed here for reference.

### Backend (`backend/.env`)

```
DATABASE_URL
REDIS_URL
JWT_SECRET
JWT_ALGORITHM
JWT_EXPIRY_HOURS
JWT_REFRESH_EXPIRY_DAYS
NEYNAR_API_KEY
NEYNAR_CLIENT_ID
LIVEKIT_API_KEY
LIVEKIT_API_SECRET
LIVEKIT_WS_URL
ENVIRONMENT
CORS_ORIGINS
LOG_LEVEL
```

### Frontend (`farcaster-audio/.env`)

```
EXPO_PUBLIC_NEYNAR_CLIENT_ID
EXPO_PUBLIC_NEYNAR_API_KEY
EXPO_PUBLIC_API_BASE_URL
EXPO_PUBLIC_LIVEKIT_WS_URL
```

## Testing

### Backend
- **Framework**: pytest
- **HTTP client**: httpx `AsyncClient`
- **Infra**: testcontainers (spins up real Postgres/Redis for integration tests)
- Run: `cd backend && pytest`

### Frontend
- **Framework**: Jest
- **Utilities**: React Native Testing Library
- Run: `cd farcaster-audio && npx jest`

## Key Files Reference

| File | Purpose |
|------|---------|
| `backend/app/services/room_service.py` | Core orchestrator: room lifecycle, LiveKit token issuance, participant management |
| `farcaster-audio/hooks/useSpace.ts` | Central frontend hook — joins/leaves spaces, manages audio state, syncs participants |
| `landing/app/page.tsx` | Landing page at juke.audio — hero, features, CTA |

## Design Context

See `.impeccable.md` for brand personality, aesthetic direction, color system, and design principles.
