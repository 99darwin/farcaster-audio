/**
 * Public release feed for Juke partner integrations.
 *
 * Append-only structured log of shipped developer-facing changes,
 * served at `https://juke.audio/changelog.json` with permissive CORS.
 * Partner agents (e.g. zaoos.com/juke-integration.md) consume this to
 * diff against their open-asks lists and auto-flip resolved items.
 *
 * Stable contract:
 *   - `version` only bumps on a breaking change to entry shape.
 *   - `entries` is reverse-chronological (newest first).
 *   - `id` is globally unique and never re-used.
 *   - `resolves` is a list of opaque partner-defined slugs — match
 *     against your own open-asks IDs.
 *   - `category` is one of: developer-api | embed | webhooks | docs.
 *   - `endpoints` is the wire surface this entry adds/changes.
 *
 * To add an entry: prepend to `entries` and ship. The route handler at
 * `app/changelog.json/route.ts` returns this as JSON with CORS open.
 */

export interface ChangelogEntry {
  id: string;
  shipped_at: string; // ISO 8601
  category: "developer-api" | "embed" | "webhooks" | "docs";
  title: string;
  summary: string;
  endpoints: string[];
  docs: string;
  docs_section: string;
  /**
   * Opaque slugs that this entry resolves. Partners maintaining
   * structured integration manifests (zaoos.com/api/juke/status, etc.)
   * use these to flip `open_asks` → `shipped` deterministically.
   */
  resolves?: string[];
  /**
   * Set to true if the entry breaks a previously-documented contract.
   * Partners can alert their team rather than auto-update.
   */
  breaking?: boolean;
}

export const CHANGELOG_VERSION = 1;

export const CHANGELOG_ENTRIES: ChangelogEntry[] = [
  {
    id: "embed-partner-token-fragment",
    shipped_at: "2026-10-17T00:00:00Z",
    category: "embed",
    title: "Pass partner tokens as #token= on embed URLs",
    summary:
      "/embed/{id} now reads the partner JWT from the URL fragment (/embed/{id}#token=...). A fragment never reaches a server, so the token stays out of request logs and Referer headers. ?token= is deprecated but still accepted; both forms are stripped from the URL on load. Embeds of rooms owned by a developer app now fail closed: if the embed-policy lookup fails, or the app is suspended or lists no allowed_origins, the page can't be framed. Inside a frame, signInWithMiniApp() now only runs when the browser can confirm that the parent is a Farcaster client (farcaster.xyz, warpcast.com) via location.ancestorOrigins; elsewhere, including Firefox, it returns null so you fall back to signInWithPopup().",
    endpoints: ["GET /v1/rooms/{id}/embed-policy"],
    docs: "https://juke.audio/SKILL.md",
    docs_section: "Partner SSO bridge",
  },
  {
    id: "embed-protocol-auth",
    shipped_at: "2026-10-16T00:00:00Z",
    category: "embed",
    title: "Embed sign-in moves to Protocol Auth",
    summary:
      "The embed SDK no longer uses the Farcaster auth relay. Inside a Farcaster Mini App host, signInWithMiniApp() has the host wallet sign an hqa1 Protocol Auth token, exchanged at POST /v1/auth/miniapp-quickauth. On ordinary webpages, signInWithPopup() runs the web auth-address flow in a first-party juke.audio window (the recovery phrase is never entered inside an embed), signs with a per-browser KeyRegistry auth address, exchanges at POST /v1/auth/protocol with use_cookie: false, and posts only the session back to the embed. Removed: startSiwfFlow(), pollSiwfStatus(), StartSiwfFlowResult, SiwfApproved, SIWF_POLL_INTERVAL_MS. completeSiwfLogin() remains but is deprecated. Anonymous listening and partner tokens are unchanged.",
    endpoints: ["POST /v1/auth/miniapp-quickauth", "POST /v1/auth/protocol"],
    docs: "https://juke.audio/SKILL.md",
    docs_section: "How sign-in works (Protocol Auth)",
    breaking: true,
  },
  {
    id: "cast-length-1024-bytes",
    shipped_at: "2026-08-10T00:00:00Z",
    category: "developer-api",
    title: "Standard cast limit raised to 1024 bytes",
    summary:
      "Non-pro cast length limit is now 1024 UTF-8 bytes (up from 320), matching the Farcaster protocol limit for standard accounts. Pro accounts remain at 10000. All Juke composers (web, iOS, Android) now count and enforce the limit in bytes rather than characters, so multibyte text (emoji, CJK) can no longer pass client-side validation and then fail at the protocol. No API shape change — POST /v1/feed/cast and /v1/feed/cast/thread bodies are unchanged.",
    endpoints: ["POST /v1/feed/cast", "POST /v1/feed/cast/thread"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Publishing Casts",
  },
  {
    id: "cast-thread-publish",
    shipped_at: "2026-07-11T00:00:00Z",
    category: "developer-api",
    title: "Cast threads — ordered multi-cast publish in one request",
    summary:
      "POST /v1/feed/cast/thread publishes a 2–10 segment cast thread server-side with guaranteed ordering: the root is posted first and each segment replies to the previous segment's canonical hash. Per-segment idempotency keys and transient-error retries; partial failures return 207 with the published prefix + failed_index so clients can resume the chain (parent = last published hash). Optional top-level parent posts the whole thread as a reply chain; channel_id applies to the root (mutually exclusive with parent); quote rides the first segment. Rate limited to 5 threads/min per fid. The juke.audio and iOS composers now build threads natively, with auto-growing inputs.",
    endpoints: ["POST /v1/feed/cast/thread"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Publishing Casts",
  },
  {
    id: "web-recognition-leaderboard",
    shipped_at: "2026-07-10T00:00:00Z",
    category: "developer-api",
    title: "Public recognition leaderboard — API + juke.audio/leaderboard",
    summary:
      "juke.audio/leaderboard now shows the monthly recognition boards (Top Hosts, Top Voices, Top Casters, Community) for the current cycle plus past months, backed by a new public leaderboard API. No auth required to view; signed-in visitors additionally see a 'Your standing' strip via GET /v1/leaderboard/me. Profiles at /app/profile/{fid} surface award badges (e.g. 'Top Host — June 2026') from GET /v1/leaderboard/awards/{fid} once a cycle closes, and users can opt out of appearing on the boards from Settings (PUT /v1/leaderboard/opt-out). Status-only — placements are badges and a spotlight, never a payout.",
    endpoints: [
      "GET /v1/leaderboard",
      "GET /v1/leaderboard/me",
      "PUT /v1/leaderboard/opt-out",
      "GET /v1/leaderboard/awards/{fid}",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Web app",
  },
  {
    id: "web-space-embed-cards",
    shipped_at: "2026-07-09T00:00:00Z",
    category: "embed",
    title: "Rich Farcaster space cards in web cast embeds",
    summary:
      "Casts embedding a farcaster.xyz/~/spaces/{uuid} link now render as a rich space card on the juke.audio web feed — host avatar, title, live/scheduled state, listener count, and a Join button — matching the mobile app. Clicking mirrors the native space into a Juke room and opens the in-app player at /app/space/{id} (anonymous visitors are routed to connect first); if the room snapshot can't be resolved the embed degrades to the generic link preview. Data comes from the existing GET /v1/farcaster-spaces/{id} proxy.",
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Web app",
  },
  {
    id: "web-space-fip2-chat",
    shipped_at: "2026-07-08T00:00:00Z",
    category: "docs",
    title: "FIP-2 live chat on web space pages",
    summary:
      "The web app's space pages (juke.audio/app/space/{id} and the host console) now render the FIP-2 live chat inline below the participant grid — the same conversation mobile shows in its Chat tab. Chat messages are Farcaster casts threaded under the room's root cast (Room.cast_hash): the panel reads the thread via GET /v1/feed/cast/thread and posts replies via POST /v1/feed/cast with parent set to the root hash, so messages are visible in any Farcaster client. Juke-hosted rooms mint their root cast on demand via POST /v1/rooms/{id}/chat-target once the session is live; native rooms use the root cast mirrored from upstream. Connected participants refresh off the space_chat/new_reply LiveKit data-channel ping; signed-in previewers poll.",
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Web app",
  },
  {
    id: "web-native-space-host-and-recording",
    shipped_at: "2026-07-07",
    category: "docs",
    title: "Web: return-to-host routing + recording for Farcaster-native spaces",
    summary:
      "Hosts returning to a live Farcaster-native space on web are now routed to the host console (with mic + moderation) instead of the listener view, and the recording toggle is available for native spaces (parity with mobile). Native participant lists also hydrate correctly now that the /v1/farcaster-spaces/* discovery reads send the caller's JWT.",
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Web app",
  },
  {
    id: "user-casts-include-replies",
    shipped_at: "2026-07-06",
    category: "developer-api",
    title: "GET /v1/users/{fid}/casts now supports include_replies for reply feeds",
    summary:
      "Pass ?include_replies=true to GET /v1/users/{fid}/casts to include the user's reply casts alongside their top-level posts. The flag is forwarded directly to Neynar's /farcaster/feed/user/casts endpoint. Defaults to false (existing behavior unchanged). Powers the Replies tab on web profile pages.",
    endpoints: ["GET /v1/users/{fid}/casts (include_replies query param)"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "User profile",
  },
  {
    id: "developer-native-self-serve-lifecycle",
    shipped_at: "2026-07-06",
    category: "developer-api",
    title: "Self-serve Farcaster-native spaces: managed bot signers, start endpoint, native webhooks",
    summary:
      "Developers can now host Farcaster-native audio spaces end-to-end from the developer API without Juke-side manual setup. Managed bot signers: POST /v1/developer/bots generates and holds an encrypted Ed25519 app key server-side; the bot account approves once via Warpcast; GET /v1/developer/bots/{id} polls signer_status until ready:true, then any API-key call can host native rooms as that bot. User-hosted passthrough: POST /v1/developer/spaces with user_jfs_bearer forwards a fresh JFS bearer signed by the end user's on-device key upstream verbatim — Juke never stores it. New POST /v1/developer/spaces/{id}/start goes live on a scheduled native room (user-hosted rooms require a fresh bearer in the body; idempotent; upstream 5xx keeps the room scheduled). Native end fixed: POST /v1/developer/spaces/{id}/end now works for native rooms (user-hosted rooms require a fresh bearer). GET /v1/developer/spaces/{id} for native rooms proxies the upstream Farcaster participant list with X-Juke-Participants-Source header. Webhooks: room.started and room.finished now fire for native rooms with new fields is_farcaster_native, farcaster_room_id, host_mode, farcaster_host_fid; ended_via vocabulary extended with upstream (reconciler-observed end); participant.joined/left and recording.ready do not fire for native rooms.",
    endpoints: [
      "POST /v1/developer/bots",
      "GET /v1/developer/bots/{bot_id}",
      "POST /v1/developer/bots/{bot_id}/signer",
      "DELETE /v1/developer/bots/{bot_id}",
      "GET /v1/developer/apps/{app_id}/bots",
      "POST /v1/developer/spaces (host_bot_fid + user_jfs_bearer fields)",
      "POST /v1/developer/spaces/{room_id}/start",
      "POST /v1/developer/spaces/{room_id}/end (user_jfs_bearer for user-hosted)",
      "GET /v1/developer/spaces/{room_id} (native: proxies upstream participants)",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster-native spaces from your server",
    resolves: [
      "developer-native-spaces-self-serve",
      "developer-bot-signer-managed",
      "developer-native-spaces-start",
      "developer-native-spaces-end",
      "developer-native-spaces-participants",
      "developer-native-webhooks",
    ],
    breaking: false,
  },
  {
    id: "web-voice-notes",
    shipped_at: "2026-07-06",
    category: "docs",
    title: "Voice-note recording in the composer + space recording playback on profiles",
    summary:
      "Users can record a voice note directly in the web composer and attach it to a cast — tap the mic icon, record, preview, and send without leaving the feed. Profile pages now list a user's past space recordings with inline playback, so listeners can catch up on spaces they missed.",
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Web app",
  },
  {
    id: "web-keyboard-shortcuts",
    shipped_at: "2026-07-06",
    category: "docs",
    title: "Keyboard shortcuts for web feed navigation",
    summary:
      "The web app now supports a full keyboard shortcut set: j/k to step through feed items, n to open a new composer, / to jump to search, ? to show the reference sheet, and additional shortcuts for common actions (like, reply, quote). The feed is fully navigable without a mouse.",
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Web app",
  },
  {
    id: "web-spaces-panel",
    shipped_at: "2026-07-06",
    category: "developer-api",
    title: "Right-hand spaces panel with real-time discovery",
    summary:
      "A persistent right-hand panel in the web app surfaces live and upcoming spaces alongside the feed. Live rooms show participant counts and a one-click join; upcoming rooms support RSVP and add-to-calendar (iCal/Google). Discovery is powered by the rooms WebSocket — the panel updates in real time without polling, so newly started spaces appear instantly.",
    endpoints: [
      "WS /v1/rooms/events (rooms WebSocket — real-time discovery feed consumed by the spaces panel)",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Web app",
  },
  {
    id: "web-composer",
    shipped_at: "2026-07-06",
    category: "docs",
    title: "Full-featured inline web composer",
    summary:
      "The web app ships an inline top-of-feed composer with the full posting feature set: @mention autocomplete, //channel autocomplete, :emoji picker, GIF picker with search, automatic link previews, draft autosave (survives page reload), quote casts, and cast delete. Everything appears inline — no navigation away from the feed.",
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Web app",
  },
  {
    id: "web-cast-threads",
    shipped_at: "2026-07-06",
    category: "docs",
    title: "Full conversation threads at /app/cast/{hash} + inline replies",
    summary:
      "The web app now renders complete nested reply threads at /app/cast/{hash}. Any cast URL can be deep-linked and opens with all replies rendered recursively. Inline replying is available directly in the thread view — the composer appears in-context without navigating away, and the thread refreshes optimistically on submit.",
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Web app",
  },
  {
    id: "web-app-beta",
    shipped_at: "2026-07-03T00:00:00Z",
    category: "docs",
    title: "Juke web app (beta) at juke.audio/app",
    summary:
      "The full Juke experience is now available in the browser. juke.audio/app runs the same feed, live audio spaces, and posting flows as the mobile app — join and host live rooms, browse your Farcaster feed, react, and cast without installing anything. A \"Launch app\" link on the landing page opens it. Sign-in uses Neynar SIWN in a real browser popup (not a WebView), so the Neynar client for juke.audio must list https://juke.audio as an authorized SIWN origin. Audio and social calls hit the same public API surface as mobile (JWT auth, /v1/rooms room lifecycle, LiveKit token issuance).",
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Web app",
  },
  {
    id: "cross-platform-scheduling-native-spaces",
    shipped_at: "2026-06-23",
    category: "developer-api",
    title: "Schedule and go live on Farcaster-native spaces",
    summary:
      'Scheduling a Farcaster-native space now works end to end. Create-time fix: the upstream POST /v1/audio-rooms create sent scheduledAt as an epoch-millis integer, which client.farcaster.xyz rejects with "scheduledAt must be a valid future timestamp" — it is now sent as an ISO-8601 string (the same form upstream returns). Go-live: a new endpoint POST /v1/rooms/{id}/native-start flips a scheduled native room scheduled->live by calling Farcaster\'s audio-room/start-scheduled with the host\'s JFS bearer (user-FID host mode) or the service bearer (legacy service-FID), then marks the Juke row active and fires discovery + RSVP go-live pushes. It allocates no Juke LiveKit resources — the host connects via the existing native-join path. The Juke-hosted go-live endpoint (POST /v1/rooms/{id}/start) now returns 400 for native rooms, pointing callers at native-start.',
    endpoints: [
      "POST /v1/rooms/{room_id}/native-start (go live on a scheduled Farcaster-native room; body { user_jfs_bearer? })",
      "POST /v1/rooms/native (scheduled_at now works end-to-end; forwarded upstream as ISO-8601)",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster-native spaces",
  },
  {
    id: "native-recording-reconciler-auto-stop",
    shipped_at: "2026-06-22",
    category: "developer-api",
    title: "Native recordings finalize when a space ends on Farcaster",
    summary:
      "Fixes orphaned recordings. Native recordings join Farcaster's LiveKit, so Juke's room_finished webhook never fires for them — the prior auto-stop never ran for spaces ended from the Farcaster app. The native-rooms reconciler (the path that actually observes an upstream end) now force-stops the recording agent before dropping the room. Recovery is automatic: the worker self-finalizes to S3 on LiveKit disconnect, so even when its process is already gone the stop path probes S3 for the uploaded file and re-links it (recording_key + a Recording row). The admin force-stop (POST /v1/admin/rooms/{room_id}/recording/stop) now also recovers from S3 and returns status 'stopped' (file recovered) or 'cleared' (flag cleared, no file) instead of a 502, and ended-but-recording rooms are surfaced in the admin list so stuck recordings are reachable.",
    endpoints: [
      "POST /v1/admin/rooms/{room_id}/recording/stop (recovers self-uploaded S3 file; returns stopped|cleared)",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster-native spaces",
  },
  {
    id: "native-recording-auto-stop-room-finished",
    shipped_at: "2026-06-20",
    category: "developer-api",
    title: "Native recordings auto-stop when the Farcaster room closes",
    summary:
      "The room_finished LiveKit webhook now auto-stops any active native recording agent when the Farcaster-side room ends (e.g. host closes via the Farcaster app). Previously the recording worker kept running until the next Railway restart, losing the file. The stop is idempotent — a concurrent manual-stop + auto-stop both racing to finalize will resolve cleanly with exactly one Recording row inserted. A new admin endpoint (POST /v1/admin/rooms/{room_id}/recording/stop) is available for force-stopping stuck recording agents without a redeployment.",
    endpoints: [
      "POST /v1/admin/rooms/{room_id}/recording/stop (force-stop stuck recording agent)",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster-native spaces",
  },
  {
    id: "native-spaces-end-user-bearer",
    shipped_at: "2026-06-10",
    category: "developer-api",
    title: "End native rooms with the user's JFS bearer",
    summary:
      "POST /v1/rooms/{room_id}/end now accepts an optional user_jfs_bearer in the body and routes the upstream audio-room/end call through it for rooms minted via the user-FID path (metadata_.host_mode == 'user_fid'). Previously the endpoint always used Juke's service-FID bearer, which Farcaster 403s on user-hosted rooms — the upstream room would stay live even though Juke marked its row 'ended'. JFS-claimed fid is cross-checked against the JWT fid. service_fid rooms keep the legacy service-bearer path (no body required).",
    endpoints: ["POST /v1/rooms/{room_id}/end (user_jfs_bearer field)"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster-native spaces",
    resolves: ["farcaster-native-spaces-end-user-hosted"],
  },
  {
    id: "native-spaces-fip2-chat-anchor",
    shipped_at: "2026-06-09",
    category: "developer-api",
    title: "FIP-2 chat for Farcaster-native spaces",
    summary:
      "POST /v1/rooms/native/mirror now accepts root_cast_hash and persists it as Room.cast_hash. POST /v1/rooms/native does the same when upstream returns one on create. Juke and Farcaster-native rooms both anchor their conversation to a root cast via FIP-2, so populating cast_hash means the in-app chat surface (which keys off Room.cast_hash) now lights up for native rooms with no further wiring. Idempotent backfill: a prior mirror call that left cast_hash null gets it set on the next mirror with a root_cast_hash; existing values are never overwritten.",
    endpoints: [
      "POST /v1/rooms/native/mirror (root_cast_hash field)",
      "POST /v1/rooms/native (cast_hash populated from upstream root cast)",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster-native spaces",
    resolves: ["farcaster-native-spaces-chat"],
  },
  {
    id: "native-spaces-in-app-listener-join",
    shipped_at: "2026-06-09",
    category: "developer-api",
    title: "In-app listener join for Farcaster-native spaces",
    summary:
      "New endpoint POST /v1/rooms/{room_id}/native-join lets an authenticated user join an existing Farcaster-native room without bouncing to the Farcaster client. The caller supplies a fresh JFS Bearer (audience https://client.farcaster.xyz) signed by their on-device Ed25519 app key; Juke's backend proxies to client.farcaster.xyz/v1/audio-room/join and returns the upstream LiveKit ws_url + token so the listener connects directly to Farcaster's LiveKit project. The JFS-claimed fid is cross-checked against the Juke JWT fid; rate-limited at 30/min per (user, room).",
    endpoints: ["POST /v1/rooms/{room_id}/native-join"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster-native spaces",
    resolves: ["farcaster-native-spaces-in-app-join"],
  },
  {
    id: "native-spaces-user-fid-jfs-bearer",
    shipped_at: "2026-06-09",
    category: "developer-api",
    title: "User-hosted Farcaster-native spaces (JFS Bearer path)",
    summary:
      "POST /v1/rooms/native now accepts an optional user_jfs_bearer field — a JFS Bearer (header.payload.signature) signed by the caller's Ed25519 app key with audience https://client.farcaster.xyz. When supplied, the upstream room is hosted by the caller's FID directly (no service-FID title prefix, no stage-invite dance). The router cross-checks the JFS-claimed fid against the Juke JWT fid. Service-FID fallback path is preserved for users without an approved app key.",
    endpoints: ["POST /v1/rooms/native"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster-native spaces",
    resolves: ["farcaster-native-spaces-user-hosted"],
  },
  {
    id: "backend-orchestrated-farcaster-native-spaces",
    shipped_at: "2026-05-30",
    category: "developer-api",
    title: "Backend-orchestrated Farcaster-native spaces",
    summary:
      "Juke now creates Farcaster-native audio spaces server-side via a service FID. Spaces appear in Warpcast's spaces carousel attributed to @jukeaudio with the host's username prefixed in the title. Joining happens via Warpcast deep-link.",
    endpoints: ["POST /v1/rooms/native"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster-native spaces",
    resolves: ["farcaster-native-spaces-backend-orchestrated"],
  },
  {
    id: "developer-api-native-mode-and-bot-registry",
    shipped_at: "2026-05-30",
    category: "developer-api",
    title: "Developer API: Farcaster-native spaces + per-app bot registry",
    summary:
      "POST /v1/developer/spaces now accepts `host: 'juke' | 'farcaster'` and `host_bot_fid` to create Farcaster-native rooms hosted by a developer-owned bot identity. POST /v1/developer/rooms/{room_id}/agent-join accepts `agent_bot_fid` to drop the partner's bot into an existing native room — returns `{wsUrl, token}` so the bot connects directly to the upstream LiveKit signaling URL. New per-app bot registry: POST /v1/developer/bots (register), GET /v1/developer/bots (list), DELETE /v1/developer/bots/{id} (deactivate). Bot custody keys are stored as opaque `env:<VAR_NAME>` references — the raw key never touches the database or response payloads.",
    endpoints: [
      "POST /v1/developer/spaces (host + host_bot_fid fields)",
      "POST /v1/developer/rooms/{room_id}/agent-join (agent_bot_fid field)",
      "POST /v1/developer/bots",
      "GET /v1/developer/bots",
      "DELETE /v1/developer/bots/{bot_id}",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Custom Server Integration: Developer Keys",
    resolves: [
      "developer-native-spaces",
      "developer-bot-registry",
      "developer-agent-join-native",
    ],
  },
  {
    id: "farcaster-sync-handshake-phase1",
    shipped_at: "2026-05-30",
    category: "developer-api",
    title: "Farcaster sync handshake (Phase 1)",
    summary:
      "Per-user opt-in handshake mints a long-lived client.farcaster.xyz bearer via Warpcast's Mini App wallet provider. Powers Phase 2 native space hosting.",
    endpoints: ["POST /v1/farcaster-sync/link"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster sync handshake",
    resolves: ["farcaster-sync-handshake"],
  },
  {
    id: "farcaster-native-space-discovery",
    shipped_at: "2026-05-30",
    category: "developer-api",
    title: "Farcaster-native space discovery",
    summary:
      "Juke now surfaces live and scheduled Farcaster-native audio spaces in discovery alongside Juke-hosted rooms. New read-only endpoints proxy Farcaster's audio-room API: list live/scheduled spaces, fetch a single space, and pull its participant list + chat history. Landing SDK ships matching TypeScript types (FarcasterNativeSpace, FarcasterNativeSpaceParticipant, FarcasterNativeSpaceChatMessage) and a DiscoverySpace discriminated union so callers can render mixed feeds with `if (s.isFarcasterNative)` narrowing.",
    endpoints: [
      "GET /v1/farcaster-spaces/live",
      "GET /v1/farcaster-spaces/scheduled",
      "GET /v1/farcaster-spaces/{id}",
      "GET /v1/farcaster-spaces/{id}/participants",
      "GET /v1/farcaster-spaces/{id}/chat",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Farcaster-native space discovery",
    resolves: ["farcaster-native-spaces", "spaces-discovery-feed"],
  },
  {
    id: "developer-reads-and-observability",
    shipped_at: "2026-05-25",
    category: "developer-api",
    title: "Developer-side reads + rate-limit + idempotency observability",
    summary:
      "New read endpoints for partners to reconcile against source of truth and inspect their webhook subscriptions: GET /v1/developer/spaces/{id} (room + live participants) and GET /v1/developer/webhooks/{id}. Every outbound webhook delivery now carries X-Juke-Idempotency-Key (= event_id) so consumers can dedupe without parsing the body. Key-authed routes return X-Juke-Rate-Limit-Limit / Remaining / Reset response headers so partners can back off proactively before 429.",
    endpoints: [
      "GET /v1/developer/spaces/{room_id}",
      "GET /v1/developer/webhooks/{webhook_id}",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Custom Server Integration: Developer Keys",
    resolves: [
      "read-developer-space",
      "read-developer-webhook",
      "rate-limit-headers",
      "idempotency-key-header",
    ],
  },
  {
    id: "developer-end-space",
    shipped_at: "2026-05-24",
    category: "developer-api",
    title: "End a room from the developer API",
    summary:
      "POST /v1/developer/spaces/{room_id}/end (key-auth, app's own rooms only) force-ends an active room. Triggers an immediate room.finished webhook — no more waiting on LiveKit's 5-minute empty-timeout. Fixed a pre-existing dispatch race that swallowed room.finished on every explicit-end path (iOS host included). The webhook payload now carries `ended_via: 'host' | 'api'` to distinguish a human host from a server-side API call.",
    endpoints: ["POST /v1/developer/spaces/{room_id}/end"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Custom Server Integration: Developer Keys",
  },
  {
    id: "partner-agent-join",
    shipped_at: "2026-05-23",
    category: "developer-api",
    title: "Free agent-join scoped to your own rooms",
    summary:
      "POST /v1/developer/rooms/{room_id}/agent-join bypasses the x402 toll for the calling app's own rooms. Same response shape and session_token semantics as the public agent-join. Rate-limited 10/min + 100/day per key, with a per-room concurrent agent cap of 5.",
    endpoints: ["POST /v1/developer/rooms/{room_id}/agent-join"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Partner agents (free, scoped to your own rooms)",
    resolves: ["agents"],
  },
  {
    id: "partner-sso-bridge",
    shipped_at: "2026-05-23",
    category: "developer-api",
    title: "Partner SSO bridge — pre-mint Juke JWT for iframe visitors",
    summary:
      "POST /v1/developer/partner-tokens issues a short-lived Juke JWT for a visitor your site has already authenticated. /embed/{id}?token=... adopts the session and skips SIWF. Partner JWTs are scoped to room participation only; sensitive endpoints reject them.",
    endpoints: ["POST /v1/developer/partner-tokens"],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Partner SSO Bridge",
    resolves: ["partner-sso-bridge"],
  },
  {
    id: "outbound-webhooks",
    shipped_at: "2026-05-23",
    category: "webhooks",
    title: "Outbound lifecycle webhooks",
    summary:
      "Subscribe a server URL to room.started/finished, participant.joined/left, recording.ready. HMAC-SHA256 signed (X-Juke-Signature), 4 retries with backoff, auto-disable after 10 consecutive failures. participant.* payloads include fid + display_name + role.",
    endpoints: [
      "POST /v1/developer/webhooks",
      "GET /v1/developer/webhooks",
      "DELETE /v1/developer/webhooks/{id}",
    ],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Lifecycle Webhooks",
    resolves: ["participant-fids"],
  },
  {
    id: "embed-audio-off",
    shipped_at: "2026-05-23",
    category: "embed",
    title: "Audio-off second-screen mode",
    summary:
      "/embed/{spaceId}?audio=off renders the embed without connecting to LiveKit audio. Solves the laptop-alongside-iOS-app double-broadcast case.",
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Fastest Integration: Hosted Iframe",
  },
  {
    id: "scheduled-countdown",
    shipped_at: "2026-05-23",
    category: "embed",
    title: "Live countdown for scheduled rooms",
    summary:
      'GET /v1/rooms/{id} returns 200 with status="scheduled" + metadata before scheduled_at. The hosted /embed/{id} renders a live countdown automatically.',
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Scheduled Spaces",
  },
  {
    id: "desktop-mic-confirmed",
    shipped_at: "2026-05-23",
    category: "docs",
    title: "Confirmed: web SDK supports mic publish after host promotion",
    summary:
      "SIWF-authed visitors can become speakers and publish a mic track on web after host promotion — same code path as iOS. Not iOS-only.",
    endpoints: [],
    docs: "https://juke.audio/llms.txt",
    docs_section: "Auth Ladder",
    resolves: ["desktop-mic"],
  },
];
