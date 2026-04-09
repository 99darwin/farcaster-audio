# Plan: eliminate steady-state Neynar "active signers" polling

## Problem

We are burning ~660k Neynar "active signers" credits in the current billing cycle for ~60 users (~11k calls per user/month). The spike correlates with the snap signer feature landing (commits `353c401`, `497a032`).

Root causes, in order of impact:

1. `GET /v1/snaps/signer-status` has **no backend cache** — every frontend call hits Neynar.
2. Frontend `snapSigner.ts` only caches `approved` (1-hour TTL) — `pending_approval`/`none` re-fetch on every `SnapCard` mount.
3. `SnapCard` fires a status check on every component instance mount — FlatList virtualization recycles cards, so scrolling away and back re-checks.
4. `AuthAddressSetup.tsx` polls every **3 seconds for 90 seconds** (30 calls/attempt) during approval.
5. `useMiniAppHost.ts` checks `getAuthAddressStatus` **twice** on every sign-in.
6. `verify_neynar_signer` (login) hits Neynar on every `/v1/auth/login` with no cache.

Neynar does **not** provide signer lifecycle webhooks (confirmed via docs.neynar.com), so push-based invalidation from their side is not an option.

## Key insight

Signer approval is a one-way door. Revocation is rare and externally triggered. We only need fresh status at the moment of use — and that moment is detectable by a failed signing attempt (4xx on snap submit). Steady-state polling exists only because we are reading Neynar as the source of truth. **If we own the truth locally, we need zero polling.**

## Design

### Backend (Phase 1) — own the truth

**New table `snap_signers`:**

| column | type | notes |
|---|---|---|
| `public_key` | `TEXT PRIMARY KEY` | hex `0x…` |
| `fid` | `BIGINT NOT NULL` | indexed |
| `status` | `TEXT NOT NULL` | `generated` / `pending_approval` / `approved` / `revoked` |
| `approval_url` | `TEXT` | nullable (cleared after approval) |
| `registered_at` | `TIMESTAMPTZ NOT NULL` | |
| `approved_at` | `TIMESTAMPTZ` | set once on transition to `approved` |
| `last_checked_at` | `TIMESTAMPTZ NOT NULL` | bounds the lazy reconcile |

**Endpoint changes — `backend/app/routers/snaps.py`:**

- `POST /v1/snaps/register-signer`
  - On success, upsert a row in `snap_signers` with the Neynar-reported status.
  - Rate limiting (3/hour/user) unchanged.

- `GET /v1/snaps/signer-status`
  - Authorization unchanged (403 if the requester does not own `public_key`).
  - **Read from `snap_signers` first.**
    - If row exists with `status == 'approved'` → return immediately, no Neynar call.
    - If row exists with `status == 'revoked'` → return immediately.
    - If row missing, or `status in ('generated', 'pending_approval')` and `last_checked_at` is older than 30 seconds → **one** Neynar call, upsert DB, return.
    - If row exists with pending status and last check < 30s ago → return stale; the client does not need sub-30s freshness.
  - Returns the same response shape as today (no client breakage).

- `POST /v1/snaps/signer-invalidate` **(new)**
  - Requires auth; authorization check on `public_key` ownership.
  - Sets `status='revoked'`, clears approval URL. Best-effort Neynar re-check (optional — the client only calls this after a submit failed, so the local signal is enough).
  - Returns 204.

**Service layer — `backend/app/services/snap_signer_service.py`:**

- New helper `get_signer_status_cached(db, public_key)` that encapsulates the "read from DB → maybe hit Neynar → upsert" logic.
- `register_ed25519_signer_with_neynar` stays; the router wraps it and persists the result.
- Add `mark_signer_revoked(db, public_key)`.

**Same pattern applied to auth address endpoints** (in the same PR, keeps the fix cohesive):

- New table `auth_addresses` with the same column shape.
- `GET /v1/auth/auth-address/status` reads from DB, lazy reconcile on pending rows.
- `POST /v1/auth/auth-address/invalidate` (new).
- `verify_neynar_signer` on login: add a Redis cache `signer_uuid → fid` with a 10-minute TTL, keyed by `signer_uuid`. Simple, absorbs login retries.

**Migration:** new Alembic revision creating `snap_signers` and `auth_addresses`, with a one-time **backfill script** (best-effort) that walks already-registered public keys from Redis ownership mappings and hits Neynar once per key to seed the DB. Backfill runs manually via a management command, not at migration time.

**Tests:**

- `tests/test_snap_signer_cache.py` — covers:
  - Cache hit on `approved` returns without calling Neynar (mock).
  - Pending status triggers exactly one Neynar call per 30s window.
  - `signer-invalidate` marks the row and subsequent reads return `revoked`.
  - Authorization boundary: caller fid ≠ signer owner returns 403.

### Frontend (Phase 2) — no polling loops

**`farcaster-audio/services/snapSigner.ts`:**

- Drop the 1-hour TTL on `approved`. Persist `approved` in SecureStore indefinitely — it's only invalidated by an explicit signal (snap submit 4xx → revoked).
- `getSnapSignerStatus(fid)` reads SecureStore first; if `approved`, return without any API call. Only hits the backend on:
  - First registration (status `generated` → `pending_approval`).
  - AppState-driven confirmation check after return from Farcaster.
  - Explicit invalidation after a failed submit.
- New helper `invalidateSnapSigner(fid)` that clears SecureStore and calls `POST /v1/snaps/signer-invalidate`.

**`farcaster-audio/components/feed/snap/SnapCard.tsx`:**

- Remove the `useEffect` at line 106–112 that fires `fetchSignerStatus` on mount.
- Read signer status from a new shared zustand slice / hook (`useSnapSignerStatus`) so N cards share one subscription.
- On submit 4xx "signer revoked" (detect by status code + error body marker), call `invalidateSnapSigner(fid)` and surface the "Tap to enable" banner.

**New `farcaster-audio/hooks/useSnapSignerStatus.ts`:**

- A zustand slice holding `{ status: SnapSignerStatus, lastCheckedAt: number }` keyed off `fid`.
- Exposes `refresh()` — used by the registration screen's AppState listener.
- Initial read is lazy: returns whatever SecureStore says synchronously (fast path), then async-verifies if missing.

**Registration screen (wherever `handleEnableInteractions` lives, currently in `SnapCard`):**

- After `registerSnapSigner(fid)` returns with an approval URL and opens Farcaster, **subscribe to `AppState`**.
- On `AppState` → `'active'` transition, fire **one** `getSnapSignerStatus` call. If approved, update the zustand slice and unsubscribe. If still pending, leave the subscription active up to a hard cap (e.g. 10 minutes total, or until the user dismisses the snap).
- Add a manual "I approved it" button as an escape hatch.

**`farcaster-audio/components/miniapp/AuthAddressSetup.tsx`:**

- **Delete the 3-second polling loop.**
- Replace with the same AppState-driven pattern: subscribe to `AppState`, fire one check on `'active'`.
- Keep the manual "I approved it" button.

**`farcaster-audio/hooks/useMiniAppHost.ts`:**

- Lines 253 / 262 currently call `getAuthAddressStatus(fid)` twice per sign-in. Collapse to a single call (or better: read from the zustand slice if fresh and skip the network entirely).

**Tests:**

- `farcaster-audio/services/__tests__/snapSigner.cache.test.ts` — SecureStore-backed `approved` returned without API call; invalidate clears it.
- `farcaster-audio/components/feed/snap/__tests__/SnapCard.signer.test.tsx` — submit 4xx "signer revoked" triggers `invalidateSnapSigner` and shows the banner.
- `farcaster-audio/components/miniapp/__tests__/AuthAddressSetup.poll.test.tsx` — no setInterval / setTimeout loop; AppState transition triggers exactly one check.

### Expected credit impact

| path | today (est.) | after |
|---|---|---|
| snap signer status | 1 call per card mount per unapproved user | 1 call per user per signer lifetime + rare revocations |
| auth address setup | up to 30 calls / attempt | 1 call / attempt |
| auth address miniapp sign-in | 2 calls / sign-in | 0 (DB) |
| login verify | 1 per login | 1 per 10 min per signer_uuid |

Target: drop the "active signers" monthly total from 660k to the low thousands.

## Execution

Two parallel worktrees off `perf/reduce-active-signers-credits`:

- **worktree-backend** → branch `perf/signer-db-cache-backend`, scope: Phase 1 (backend only).
- **worktree-frontend** → branch `perf/signer-appstate-flow-frontend`, scope: Phase 2 (frontend only).

Backend and frontend touch disjoint directories (`backend/` vs `farcaster-audio/`) so merge conflicts are not possible. Each subagent:

1. Implements its phase per the design above.
2. Adds tests for every new behavior.
3. Runs the relevant test + typecheck commands (`pytest` for backend, `npx tsc --noEmit && npx jest` for frontend).
4. Does **not** push or open a PR. Returns a summary + worktree path.

Parent (this branch) then merges both worktree branches in, the plan file is removed, the combined diff is pushed, and a single PR is opened.

## Out of scope (for this PR)

- Redesigning the approval UX beyond removing polling (no new screens).
- Changing how we store the Ed25519 private key (still SecureStore `_THIS_DEVICE_ONLY`).
- Migrating login auth off Neynar signer verification.
- Snap v2 client work — already shipped in PR #43.
