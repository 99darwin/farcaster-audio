# Juke Calendar, Space Notifications, and Channels — Orchestrated Build Spec

**Version:** 0.1
**Status:** Draft — ready for orchestrated agent execution
**Owner:** Nick
**Last updated:** 2026-05-08

---

## 1. Strategic context

Juke already behaves like a lightweight Farcaster client: a reverse chronological
following feed, native cast actions, voice notes, and persistent live audio
spaces. The next useful step is to make scheduled spaces more reliable and make
the feed/composer feel less constrained than a minimal MVP client.

This spec covers three shippable features:

1. Add scheduled spaces to a user's calendar from Juke iOS, Juke web, or a
   Farcaster miniapp client.
2. Reliably notify users when a scheduled space goes live, with an admin-only
   option to notify all active Juke users while the userbase is small.
3. Add Farcaster channel support: view channel feeds and cast into existing
   channels from the Juke composer.

Private voice-note messaging is intentionally excluded. It is a larger product
surface with separate authorization, privacy, inbox, and media-access concerns.

---

## 2. Goals and non-goals

### Goals

- A scheduled space has a stable calendar URL that works from any client.
- Juke iOS users can add scheduled spaces to their native calendar.
- Miniapp/web users can download/open an `.ics` calendar event without logging
  into the native app.
- RSVP'd users receive a push when the host starts a scheduled space.
- Admins can trigger a "space is live" broadcast to all active push-capable Juke
  users for a specific room.
- Channel feeds can be opened from Juke and paginated.
- The compose modal can post a top-level cast into an existing channel.
- Channel posting preserves existing reply, quote, embed, and voice-note flows.

### Non-goals

- Creating Farcaster channels.
- Managing channel memberships, moderation, or notifications.
- Algorithmic channel discovery.
- Background push scheduling before the host starts a room.
- Full calendar sync, calendar event update tracking, or attendee invite
  management.
- Private DMs or private voice-note delivery.
- Ticker/cashtag composer support. The first channel iteration only adds the
  channel target affordance from the reference composer pattern.

---

## 3. Product requirements

### P0. Calendar add for scheduled spaces

Scheduled space pages and native scheduled-space views should always expose an
"Add to Calendar" action when `room.status === "scheduled"` and
`room.scheduled_at` is present.

Expected behavior:

- Web/miniapp: opens `/space/{room_id}/calendar.ics` or equivalent download URL.
- Native Juke: uses iOS calendar permissions and creates an event locally.
- Fallback: if native calendar write fails or permission is denied, open/share
  the `.ics` URL.
- The action is visible regardless of RSVP state, including when a scheduled
  space is opened from a shared link.
- Upcoming spaces scheduled before this feature ships are supported
  retroactively because the ICS/native event is derived from existing room data;
  no backfill migration is required.
- Event title: `Juke Space: {room.title}`.
- Event location/url: `https://juke.audio/space/{room_id}`.
- Event notes: host display name, join URL, and "Starts on Juke".
- Default duration: 60 minutes.
- Event UID: stable per room, e.g. `juke-space-{room_id}@juke.audio`.
- Calendar export must never expose secrets, LiveKit tokens, or user JWTs.

### P0. Space start notifications

When a scheduled room transitions to active, Juke should notify users who are
likely to care and make failures observable.

Expected behavior:

- Host starts a scheduled room through `POST /v1/rooms/{room_id}/start`.
- Backend sends `space_live` push to every RSVP'd FID except the host.
- Push respects user-level space notification preferences unless the operation
  is an admin broadcast.
- Push target includes native Expo device tokens.
- Miniapp notification tokens are included when available and enabled.
- Delivery is idempotent per `(room_id, campaign_type, fid)` so retries do not
  spam users.
- Admin-only endpoint can broadcast the live-room notification to every
  reachable Juke user, defined as every FID with at least one active native or
  miniapp notification target.
- Admin `all_active` broadcasts always bypass `space_started_enabled` for now,
  except invalid/deactivated tokens. This is an explicit small-userbase product
  decision and should be easy to reverse later if the app grows.
- Logs/response report attempted recipients, delivered request count, skipped
  recipients, and invalid-token cleanup count.

Suggested notification copy:

- Title: `Space is live`
- Body: `{host_display_name}: {room.title}`
- Data: `{ "type": "space_live", "url": "/space/{room_id}", "room_id": "{room_id}" }`

### P1. Channel support

Users should be able to read existing channel feeds and cast into a selected
channel from the same composer they already use.

Expected behavior:

- Add channel feed screen: `/channel/{channel_id}` in the native app.
- Feed screen fetches channel casts through backend Neynar proxy.
- Feed cards retain existing like, recast, reply, quote, and open-thread flows.
- Compose modal supports an optional channel target for top-level casts.
- Reply casts should continue using `parent`; channel selection is disabled or
  hidden while replying.
- Quote casts can be posted to a channel.
- Voice notes can cast to a channel in v1 when `post_to_farcaster` is true.
- The selected channel target is explicit in the UI and cleared after publish.

Channel ID handling:

- Treat channel IDs/keys as untrusted user input.
- Validate to a conservative slug format before passing to Neynar.
- Store no channel state in Postgres for v1.
- Cache channel feed responses only if an existing feed cache pattern exists.

---

## 4. Backend API contracts

### Calendar export

Add one of the following. Prefer the landing route if Next.js can fetch room
detail without introducing auth coupling; use the backend route if keeping ICS
generation near room data is simpler.

#### Option A: Next.js route

`GET /space/{room_id}/calendar.ics`

#### Option B: Backend route

`GET /v1/rooms/{room_id}/calendar.ics`

Response:

- `Content-Type: text/calendar; charset=utf-8`
- `Content-Disposition: attachment; filename="juke-space-{room_id}.ics"`
- `404` if room does not exist.
- `409` if room is not scheduled or has no `scheduled_at`.

ICS requirements:

- Escape commas, semicolons, backslashes, and newlines per iCalendar rules.
- Use UTC `DTSTART`/`DTEND`.
- Include `UID`, `DTSTAMP`, `SUMMARY`, `DESCRIPTION`, `URL`, and `STATUS`.

### Space live notification delivery

Add a service-level method rather than keeping delivery inline in
`RoomService.start_scheduled_room`.

```python
await push.notify_space_started(
    room_id=str(room.id),
    title=room.title,
    host=host,
    target="rsvps",
    respect_preferences=True,
)
```

Admin endpoint:

`POST /v1/admin/rooms/{room_id}/notify-live`

Auth:

- Existing Juke admin JWT auth via `get_admin_user`, matching the other
  interactive `/v1/admin/rooms/*` endpoints. `X-Admin-Secret` remains reserved
  for scheduler/ops endpoints such as recording cleanup.

Request:

```json
{
  "target": "all_active",
  "dry_run": false
}
```

Response:

```json
{
  "room_id": "uuid",
  "target": "all_active",
  "dry_run": false,
  "recipient_count": 42,
  "native_push_count": 39,
  "miniapp_push_count": 18,
  "skipped_count": 3
}
```

Rules:

- `target` may be `rsvps` or `all_active`.
- Non-admin room start path only uses `rsvps`.
- Admin `all_active` broadcast bypasses `space_started_enabled` and targets
  every reachable FID with an active registered native or miniapp notification
  channel. Log the preference bypass explicitly.
- `dry_run=true` returns counts for the same all-reachable target set without
  sending any push requests.
- Return `400` for non-active rooms.
- Return `404` for missing rooms.

### Channel feed and cast proxy

Extend the feed proxy. Exact Neynar parameter names must be checked against the
current Neynar docs during implementation.

`GET /v1/feed/channel/{channel_id}`

Query:

- `limit`: 1-100, default 25.
- `cursor`: optional.

Response:

- Pass-through Neynar channel feed shape after spam annotation.

`POST /v1/feed/cast`

Extend `CastRequest`:

```python
channel_id: str | None = Field(default=None, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")
```

Rules:

- `channel_id` allowed only for top-level casts.
- If `parent` is present, reject `channel_id` with `400`.
- Backend converts `channel_id` into the Neynar channel posting field.
- Existing text/embed/quote validation remains unchanged.

Voice notes:

Extend `VoiceNoteCreateRequest` with optional `channel_id` under the same
validation rules. Only apply it when `post_to_farcaster` is true and
`parent_cast_hash` is absent.

---

## 5. Native app UX

### Scheduled space screen

File likely touched: `farcaster-audio/app/space/[id].tsx`.

Add a calendar action next to RSVP/share for scheduled spaces:

- Host view: `Start`, `Cancel`, `Add to Calendar`, `Share`.
- Viewer view: `RSVP`, `Add to Calendar`, `Share`.
- Add to Calendar remains visible before and after RSVP.
- If calendar permission is denied, fall back to opening/share sheet for the ICS
  URL.

Native dependency:

- Add `expo-calendar` if compatible with the installed Expo SDK.
- Add `NSCalendarsUsageDescription` / relevant Expo config entry.
- Lockfile/package updates must be serialized before parallel worker tasks.

### Channel feed

New route:

- `farcaster-audio/app/channel/[id].tsx`

Suggested entry points:

- Tapping a channel label on a cast opens the channel screen.
- Composer channel picker can open a channel after successful post.

### Composer channel selection

Likely files:

- `farcaster-audio/components/feed/ComposeModal.tsx`
- `farcaster-audio/stores/composeStore.ts`
- `farcaster-audio/services/api.ts`
- `farcaster-audio/types/api.ts`

UX requirements:

- Add a compact dashed `Channel` pill in the compose body area for top-level
  text casts and voice notes, matching the reference Farcaster composer pattern.
- Do not add the reference screenshot's `Ticker` pill in this iteration.
- Pressing the pill opens manual channel entry/selection.
- Hide or disable channel selection for replies.
- Keep composer dense and client-like; do not add onboarding prose.
- Show the selected channel as `/{channel_id}` with a clear/remove affordance.
- Clear the selected channel after successful publish or composer reset.
- Validate channel IDs locally before submit.
- Surface backend validation failures as normal compose errors.

---

## 6. Landing and miniapp UX

Likely files:

- `landing/app/space/[id]/page.tsx`
- `landing/lib/spaces.ts`
- `landing/app/space/[id]/calendar.ics/route.ts` or equivalent route handler

Requirements:

- Scheduled space landing page includes "Add to Calendar".
- Add to Calendar is visible for every upcoming scheduled space, regardless of
  RSVP state or whether the room was scheduled before the feature shipped.
- The button is visible in miniapp webviews and normal browsers.
- Generated ICS works without auth.
- The action does not interfere with existing join/install CTAs.

---

## 7. Orchestrated implementation plan

This plan follows the `orchestrator` skill lifecycle:

`implement -> /secure -> /audit -> fix -> verify -> fix -> done`

### Phase 0: serialize package/config changes

This phase is not parallel-safe because it may write shared config and lockfiles.

Owner: orchestrator or a single setup worker.

Write set:

- `farcaster-audio/package.json`
- `farcaster-audio/package-lock.json`
- `farcaster-audio/app.json`

Task:

- Add `expo-calendar` if needed.
- Add calendar permission copy.
- Run the appropriate install command.
- Report exact package/version changes.

Verification:

- `cd farcaster-audio && npx expo install --check` or equivalent.
- `cd farcaster-audio && npx tsc --noEmit` if configured.

### Phase 1: dispatch parallel workers

The following workers are parallel-safe after Phase 0 because their primary
write sets are disjoint. If a worker discovers it must edit outside its write
set, it must stop and report scope expansion.

#### Worker A: calendar export and landing button

Write set:

- `landing/app/space/[id]/page.tsx`
- `landing/app/space/[id]/calendar.ics/route.ts`
- `landing/lib/spaces.ts`
- `landing/__tests__/**` if tests exist

Acceptance criteria:

- Scheduled space web page exposes Add to Calendar for all upcoming scheduled
  rooms, including rooms created before this feature ships.
- ICS endpoint returns valid iCalendar for scheduled rooms.
- Non-scheduled rooms return a non-2xx response.
- No auth or token data appears in the ICS response.

Verification target:

- Domain: frontend/backend mixed.
- Start landing dev server.
- Open a scheduled space page and click Add to Calendar.
- Fetch the `.ics` URL and inspect headers/body.
- Run landing type/lint/test command available in `landing/package.json`.

#### Worker B: reliable space-start push delivery

Write set:

- `backend/app/services/push_service.py`
- `backend/app/services/room_service.py`
- `backend/app/routers/admin.py`
- `backend/app/schemas/push.py` if needed
- `backend/tests/test_*push*.py`
- `backend/tests/test_*room*.py`
- `backend/tests/test_*admin*.py`

Acceptance criteria:

- `start_scheduled_room` delegates to a push service method.
- RSVP notifications respect preferences and include native + miniapp channels.
- Admin endpoint can dry-run and send `all_active` live-room broadcast to every
  reachable user, independent of `space_started_enabled`.
- Admin broadcast logs the preference bypass and still excludes invalid or
  deactivated tokens.
- Delivery is idempotent per room/campaign/user.
- Tests cover RSVP delivery, self-skip, preference skip for the non-admin path,
  dry-run, admin preference bypass, admin auth, and invalid room state.

Verification target:

- Domain: backend.
- `cd backend && pytest tests/test_*push*.py tests/test_*room*.py tests/test_*admin*.py`
- Targeted HTTP checks for `POST /v1/admin/rooms/{room_id}/notify-live`.

#### Worker C: channel backend proxy

Write set:

- `backend/app/routers/feed.py`
- `backend/app/routers/voice_notes.py`
- `backend/app/schemas/voice_note.py`
- `backend/tests/test_feed*.py`
- `backend/tests/test_voice_notes.py`

Acceptance criteria:

- Channel feed endpoint proxies Neynar through the backend.
- `POST /v1/feed/cast` accepts `channel_id` for top-level casts only.
- Replies with `channel_id` are rejected.
- Voice notes can cast to a channel only for top-level Farcaster posts.
- Voice-note channel posting is included in the first channel release.
- Existing feed, reply, quote, and voice-note tests continue to pass.

Verification target:

- Domain: backend.
- `cd backend && pytest tests/test_feed*.py tests/test_voice_notes.py`
- Mock Neynar requests verify correct channel fields are sent upstream.

#### Worker D: native scheduled-space calendar action

Write set:

- `farcaster-audio/app/space/[id].tsx`
- `farcaster-audio/services/calendar.ts`
- `farcaster-audio/constants/config.ts` if ICS URL helper is needed
- `farcaster-audio/__tests__/**` or nearby tests if they exist

Acceptance criteria:

- Scheduled space screen has Add to Calendar for all upcoming scheduled rooms,
  including rooms created before this feature ships.
- Native calendar event creation works when permission is granted.
- Permission denied or runtime failure falls back to the ICS URL/share flow.
- Action is visible regardless of RSVP state and hidden for active/ended rooms.

Verification target:

- Domain: frontend/native.
- Run mobile typecheck/Jest command.
- Manual simulator flow: scheduled room -> Add to Calendar -> permission
  prompt/fallback behavior.

#### Worker E: native channel feed and composer

Write set:

- `farcaster-audio/app/channel/[id].tsx`
- `farcaster-audio/components/feed/ComposeModal.tsx`
- `farcaster-audio/stores/composeStore.ts`
- `farcaster-audio/services/api.ts`
- `farcaster-audio/types/api.ts`
- `farcaster-audio/hooks/useChannelFeed.ts`
- `farcaster-audio/__tests__/**` or nearby tests if they exist

Acceptance criteria:

- `/channel/{id}` displays a paginated channel feed.
- Composer shows a dashed `Channel` pill, can select/clear a channel target for
  top-level casts, and does not add ticker/cashtag support.
- Composer submits channel target through backend API.
- Channel selection is unavailable for replies.
- Voice-note Farcaster posting can include the selected channel target.

Verification target:

- Domain: frontend/native.
- Run mobile typecheck/Jest command.
- Manual simulator flow: open channel -> paginate feed -> compose top-level
  cast to channel -> reply composer does not show channel picker.

### Phase 2: collect, verify, and loop

For each completed worker:

1. Spawn a verifier using the worker's reported verification target.
2. Treat environmental failures separately from implementation bugs.
3. Re-dispatch the owning worker with all verifier bugs in one prompt.
4. Stop after 5 worker iterations and surface the blocker.

### Phase 3: final integration pass

After all workers pass their local verification:

- Run backend targeted tests.
- Run mobile typecheck/Jest if configured.
- Run landing type/lint/build command if configured.
- Smoke-test core flows:
  - Scheduled room page renders.
  - Calendar download works for an already-created upcoming scheduled room.
  - Scheduled room start sends RSVP notification path.
  - Admin live-room notification dry-run works.
  - Admin live-room notification dry-run ignores user preferences.
  - Following feed still loads.
  - Channel feed loads.
  - Top-level channel cast submits.
  - Top-level voice note can post to a channel.
  - Reply cast still submits.

---

## 8. Security and abuse notes

- Calendar ICS generation must escape all user-controlled text.
- Calendar routes must not leak JWTs, LiveKit tokens, signer UUIDs, admin
  secrets, or private API URLs.
- Admin broadcast must stay behind existing admin JWT auth.
- Admin broadcast should have dry-run support and structured logs, and those
  logs must state that the all-active path bypassed notification preferences.
- Do not send duplicate live notifications to the same FID across native and
  miniapp channels without an explicit product decision; one FID may have both.
- Channel IDs must be validated before hitting Neynar.
- Backend must never accept `signer_uuid` from the client.
- SSRF protections in existing OG/media code are out of scope but must not be
  weakened by channel work.

---

## 9. Locked decisions

- Admin `all_active` broadcasts always notify every reachable user for now,
  regardless of `space_started_enabled`.
- "Every user" means every user with an active registered native or miniapp
  notification target, not every user row in Postgres.
- Add to Calendar is always visible for upcoming scheduled spaces, including
  spaces opened from shared links and spaces scheduled before this feature ships.
- Existing upcoming scheduled spaces are made retroactive by behavior, not by
  backfilling rows.
- Channel suggestions/discovery are not required; manual channel
  selection/entry is acceptable for v1.
- The composer follows the reference Farcaster app pattern with a `Channel` pill
  only. The `Ticker` pill is out of scope.
- Channel posting for voice notes ships in the first channel release.
