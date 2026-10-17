---
name: juke-spaces-embed
description: Embed live Farcaster audio spaces (Juke) into a website, miniapp, or React app. Use this skill whenever a developer wants to add live audio rooms, voice chat, persistent audio, Twitter/X Spaces–style rooms, Clubhouse-style rooms, listener-only audio streams, host-approved speaking, hand-raise queues, audio reactions, or any Farcaster-native audio social feature — even if they don't say the word "Juke". Two integration paths exist: a hosted iframe (zero-config) and a JavaScript SDK (custom UI). Trigger this skill for prompts like "add audio rooms to my site", "embed a live space", "add voice chat with Farcaster sign-in", "ship a Twitter Spaces clone", "let users listen to a live room on my landing page", or any request that involves real-time audio rooms tied to Farcaster identity.
---

# Juke Spaces Embed

Juke is a hosted backend + LiveKit-based audio service for Farcaster-native live audio rooms ("spaces"). This skill helps you ship a Juke space inside a website, miniapp, or React app.

> **Sign-in is Protocol Auth.** Visitors authenticate with a token signed by a key
> the Farcaster contracts on Optimism tie to their FID — the Mini App host's wallet,
> or an auth address this browser linked once. No Farcaster-hosted relay or auth
> server is involved. Anonymous listening needs no sign-in at all.

There are three integration layers over the same room model. Pick the lightest one that works:

- **Hosted iframe** — paste one `<iframe>` tag. Juke renders the whole UI. Auth, LiveKit, attribution, updates, mic permissions: all handled.
- **SDK / custom UI** — your code calls Juke's API and drives LiveKit directly. You render your own design system.
- **Developer API keys** — server-side integrations for protected Juke developer APIs. These require Juke approval and a server-held secret key.

Neither iframe nor SDK is mandatory. Default to the iframe unless the developer signals they want custom UI. Do not ask developers for Farcaster provider or LiveKit keys.

## Decision: iframe or SDK?

Use this decision tree before writing any code.

**Use the hosted iframe when:**
- The developer says "fastest way" / "just drop it in" / "MVP" / "landing page" / "marketing site".
- Juke-branded UI is acceptable.
- The page doesn't already have a design system the embed must match.

**Use the SDK when:**
- The developer says "custom UI" / "match our design" / "I already have a design system".
- They want non-standard layouts (e.g., a sidebar player, a sticky bottom dock).
- They want to render the participant list inside their own profile cards.
- They're building inside a Farcaster miniapp and want native-feeling controls.

When in doubt, recommend the iframe first and offer the SDK as an upgrade path. The two share the same backend, so switching later is just a UI rewrite, not a re-architecture.

---

## Recipe 1: Hosted iframe (30-second integration)

Drop this into any HTML page. Replace `{spaceId}` with the Juke space UUID.

```html
<iframe
  src="https://juke.audio/embed/{spaceId}"
  title="Juke live audio space"
  allow="autoplay; microphone"
  style="width: 100%; max-width: 480px; height: 720px; border: 0; border-radius: 24px;"
></iframe>
```

That's it. The iframe handles:
- public room metadata fetch
- anonymous listening (no sign-in)
- "Sign in to participate" via Protocol Auth (Mini App host wallet, or this browser's linked auth address)
- reactions, hand raise, mic (after host promotion)
- LiveKit connection and reconnection
- Juke attribution

No Juke developer API key is required for hosted iframes.

Notes:
- `autoplay` is needed so audio starts after the listener clicks "Listen". Browsers gate autoplay behind a user gesture, which the iframe handles internally.
- `microphone` is only required if the listener may eventually speak. You can omit it for listen-only deployments, but the iframe will still render the participate buttons in disabled state — better to include `microphone` and let the host's promotion model gate actual mic publishing.
- HTTPS is mandatory for mic access in browsers.
- The iframe is intentionally narrow (≈ 480px). It's designed to live in a sidebar, modal, or single-column page.

Supported iframe URL params:

- `?audio=off` — renders title, host, and the current participant list but never connects to LiveKit audio. Use this for "second-screen" pages where the visitor is already listening in the Juke app (or another tab) and would otherwise double-broadcast.

Do not invent other params. The safe default is the full participate UI with anonymous listening and optional sign-in.

---

## Recipe 2: SDK / custom UI

The SDK is a thin TypeScript class that wraps Juke's REST API and the LiveKit client. The package isn't published to npm yet; until then, copy `lib/juke-embed-sdk.ts` and `lib/spaces.ts` from the Juke repo (`landing/lib/`) into the project.

Once published it will install as:

```bash
npm install @juke/audio-sdk livekit-client
```

### Full lifecycle in one file

This is the canonical flow. Adapt the JSX to the developer's design system; keep the SDK call order intact.

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import {
  createJukeEmbedSdk,
  JukeEmbedAuthError,
  type JukeEmbedSdk,
} from "@/lib/juke-embed-sdk";
import type { JoinSpaceResponse } from "@/lib/spaces";

export function MySpace({ spaceId }: { spaceId: string }) {
  const sdkRef = useRef<JukeEmbedSdk>();
  const [join, setJoin] = useState<JoinSpaceResponse | null>(null);
  const [isAuthed, setIsAuthed] = useState(false);
  const [showWebSignIn, setShowWebSignIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!sdkRef.current) sdkRef.current = createJukeEmbedSdk();

  // 1. Anonymous listening — no sign-in required.
  async function listen() {
    const j = await sdkRef.current!.joinAnonymousListener(spaceId);
    await sdkRef.current!.connectAudio(j);
    setJoin(j);
  }

  async function joinAsParticipant() {
    const j = await sdkRef.current!.joinAuthenticated(spaceId);
    await sdkRef.current!.connectAudio(j);
    setJoin(j);
    setIsAuthed(true);
    setShowWebSignIn(false);
  }

  // 2. Protocol Auth. Inside a Farcaster Mini App host the host wallet
  //    signs an `hqa1` token — no QR, no second app. Outside a host
  //    `signInWithMiniApp()` returns null: offer the web flow instead.
  async function signIn() {
    setError(null);
    try {
      const session = await sdkRef.current!.signInWithMiniApp();
      if (session) return await joinAsParticipant();
      setShowWebSignIn(true);
    } catch (err) {
      if (!(err instanceof JukeEmbedAuthError)) throw err;
      // user_cancelled → stay quiet; network / timeout → let them retry;
      // verify_failed → the host wallet can't sign for this account, so
      // the web flow is the way forward.
      if (err.reason !== "user_cancelled") setError(err.message);
      if (err.reason === "verify_failed") setShowWebSignIn(true);
    }
  }

  // 3. Web flow: opens a first-party juke.audio window. A returning
  //    browser signs with its stored auth address; a new browser links
  //    once there with the recovery phrase. Only the session comes back.
  //    Call it straight from a click so the popup isn't blocked.
  async function signInOnJuke() {
    setError(null);
    try {
      await sdkRef.current!.signInWithPopup();
      await joinAsParticipant();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign in");
    }
  }

  // Clean up the audio connection on unmount.
  useEffect(() => () => {
    sdkRef.current?.leaveSpace().catch(() => {});
  }, []);

  // 4. Authenticated actions.
  const react = () => sdkRef.current!.sendReaction("clap");
  const raiseHand = () => sdkRef.current!.raiseHand(spaceId, true);
  const speak = () => sdkRef.current!.enableMicrophone(true); // throws unless host promoted

  return (
    <div>
      {error && <p role="alert">{error}</p>}
      {!join && <button onClick={listen}>Listen</button>}
      {join && !isAuthed && !showWebSignIn && (
        <button onClick={signIn}>Sign in to participate</button>
      )}
      {showWebSignIn && (
        <>
          <button onClick={signInOnJuke}>Continue on juke.audio</button>
          <button onClick={() => setShowWebSignIn(false)}>Cancel</button>
        </>
      )}
      {isAuthed && (
        <>
          <button onClick={react}>👏</button>
          <button onClick={raiseHand}>Raise hand</button>
          <button onClick={speak}>Unmute</button>
        </>
      )}
    </div>
  );
}
```

`signInWithPopup({ signal? })` only works where the SDK runs on the juke.audio origin (the hosted iframe, or a page served from juke.audio): the popup hands the session back with a same-origin `postMessage`, and the sign-in page refuses to render inside a frame or for a cross-origin opener. If you sandbox the iframe, include `allow-popups`. The embed never renders a recovery-phrase field. On your own origin, use the hosted iframe, a Mini App host, or a partner token (`adoptPartnerSession`).

`signInWithAuthAddress(fid)` remains for returning browsers on the juke.audio origin; it throws `LinkRequiredError` when this browser has no linked key for the FID — send the visitor through `signInWithPopup()` to link it.

### How sign-in works (Protocol Auth)

Juke authenticates with **Protocol Auth**: an EIP-4361 (SIWE) message that says `Authenticate as Farcaster FID {fid}.`, signed by a key that the Farcaster contracts on Optimism tie to that FID, sent as an `hqa1.<base64url message>.<base64url signature>` token. The backend verifies it against on-chain state. There is no Farcaster-hosted relay, auth server, or approval app in the loop.

- **Inside a Farcaster Mini App host** — `signInWithMiniApp()` uses `protocolAuth.getToken()` from `@farcasterorg/miniapp-sdk`. The host wallet signs a token for the host's user FID and `POST /v1/auth/miniapp-quickauth` exchanges it for a Juke JWT (≤ 1h, never longer than the token; no refresh token). The SDK re-signs with the host wallet when that JWT nears expiry. The host wallet must be the FID's custody address or one of its KeyRegistry auth addresses; otherwise the exchange returns 401 and the call throws — fall back to the web flow.
- **Ordinary webpage** — the browser generates its own secp256k1 key (an *auth address*, KeyRegistry keyType 2), stored in IndexedDB encrypted under a non-extractable WebCrypto key. The first time, the visitor enters their custody recovery phrase once; it signs the KeyGateway `Add`s for that auth address and Juke's app signer locally, in the tab, and Juke relays them on Optimism. After that the browser signs Protocol Auth tokens by itself and `POST /v1/auth/protocol` mints the session (refresh token in the body when `use_cookie: false`).

### Inside the native Juke iOS app

Use the app's own on-device auth-address flow (the iOS app generates a secp256k1 keypair on-device and adds it to the Optimism KeyRegistry once, signed locally with the account's recovery phrase). Don't pop a web popup or render a phrase field inside a React Native WebView.

### Breaking changes in the embed SDK

| Removed | Use instead |
|---|---|
| `startSiwfFlow()`, `pollSiwfStatus()`, `StartSiwfFlowResult`, `SiwfApproved`, `SIWF_POLL_INTERVAL_MS` | `signInWithMiniApp()` inside a Mini App host; `signInWithPopup()` (a first-party juke.audio window) everywhere else |

`completeSiwfLogin({ message, signature })` still exists but is deprecated: nothing in the SDK produces those credentials any more. Sessions now carry a `source` field (`"protocol" | "miniapp" | "partner" | "siwf"`). Everything else — `adoptPartnerSession`, `joinAnonymousListener`, `joinAuthenticated`, `leaveSpace`, `refreshToken`, `sendReaction`, `raiseHand`, `connectAudio`, `enableMicrophone`, `isAuthenticated`, `authenticatedFid` — is unchanged.

---

## Auth ladder (the most important rule)

Follow this order. It exists because requiring sign-in before listening is the single biggest reason audio embeds get abandoned by anonymous web visitors:

1. **Render room metadata without auth.** Title, host, listener count, status — all public.
2. **Let visitors listen anonymously.** One click, no popup, no sign-in.
3. **Prompt "Sign in to participate" only when they try to interact.** Reactions, replies, hand raise.
4. **Choose the right auth method for the context:**
   - Farcaster Mini App host → `signInWithMiniApp()` (host wallet signs a Protocol Auth token)
   - Ordinary webpage → web auth-address flow via `signInWithPopup()` (a juke.audio window; recovery phrase once per browser, never inside the embed)
   - Native iOS app → on-device auth-address (KeyRegistry auth address, Protocol Auth tokens)
5. **Request browser mic permission only after the host promotes the listener** to speaker/co-host/host. Browsers prompt aggressively, so asking before the user can actually speak is wasted goodwill.

If a developer asks you to gate listening behind sign-in, push back once and explain the cost. If they insist, do it — it's their product.

---

## Permission model

The backend enforces these, so violating them client-side just produces errors. Knowing them up front prevents misleading UI.

| Role | Listen | React/Reply | Raise hand | Publish mic |
|---|---|---|---|---|
| Anonymous listener | yes | no | no | no |
| Authenticated listener | yes | yes | yes | no — host must promote |
| Speaker | yes | yes | yes | yes |
| Co-host | yes | yes | yes | yes |
| Host | yes | yes | yes | yes |

Anonymous listeners are counted in the aggregate `listener_count`. They are not shown as named participants. This is intentional — the named participant list is a Farcaster social signal, not a presence indicator.

`enableMicrophone(true)` throws `"A host must approve you before you can speak"` if the join's role is not in `{speaker, co_host, host}`. Surface this message; don't catch and hide it.

---

## Security considerations: what a sign-in proves

Every Protocol Auth token is a SIWE message with the requesting **domain** and **URI** as first-class fields, `chain-id: 10`, a resource of `farcaster://fid/{fid}`, and a lifetime of at most one hour.

**Server-side verification.** The backend re-serializes the message and requires an exact match, checks that the domain is one it serves (`juke.audio`), checks the expiry, recovers the signer, and confirms on Optimism that the signer is the FID's custody address or an active KeyRegistry auth address for that FID. The FID comes from the signed message and the chain, never from an unsigned client field.

**Defense-in-depth:**

- **Single-use nonces on the web flow** — `/v1/auth/protocol` burns a server-issued nonce from `/v1/auth/siwf/nonce`. Replays fail.
- **Short-lived Mini App sessions** — a session from `/v1/auth/miniapp-quickauth` never outlives the host-signed token (≤ 1h) and carries no refresh token.
- **The recovery phrase never leaves the tab** — the web link flow signs locally and sends only signatures. It is only entered in a top-level juke.audio window, never inside an embed, and only the minted session is posted back to the embed.
- **Per-browser keys** — a browser's auth address can only authenticate as the FID (it cannot move the FID or add keys), is stored encrypted at rest, and can be revoked on-chain without touching the custody key.

**What integrators should do.** Never collect a Farcaster recovery phrase yourself, and never ask for one inside a frame — a framing page can overlay or clickjack it. Use the hosted iframe (or `signInWithPopup()` from the juke.audio origin): the phrase is only ever entered in a top-level juke.audio window that refuses to render when framed, and only the resulting session is posted back. Because that window is first-party, a browser linked on juke.audio is not asked again on your site.

---

## API surface (REST)

Base URL: `https://your-api-host.example.com`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/rooms/{spaceId}` | none | Public room metadata + participant list |
| GET | `/v1/rooms/{spaceId}/embed-policy` | none | Per-room `allowed_origins` for CSP `frame-ancestors` (null when the room has no owning developer app) |
| POST | `/v1/rooms/{spaceId}/anonymous-join` | none | Listener-only LiveKit token |
| POST | `/v1/rooms/{spaceId}/join` | Bearer | Authenticated join, role-scoped LiveKit token |
| POST | `/v1/rooms/{spaceId}/leave` | Bearer | Mark left, clean up participant row |
| POST | `/v1/rooms/{spaceId}/token` | Bearer | Refresh expiring LiveKit token |
| POST | `/v1/rooms/{spaceId}/raise-hand` | Bearer | Toggle hand-raise (`{"raised": bool}`) |
| POST | `/v1/auth/siwf/nonce` | none | Issues a single-use nonce (10-minute TTL) for a web Protocol Auth token. Rate-limited 30/min per IP. |
| POST | `/v1/auth/protocol` | none | Exchanges an `hqa1` Protocol Auth token (signed by a linked auth address or the custody key, carrying a nonce from `/v1/auth/siwf/nonce`) for a Juke JWT. Body: `{token, use_cookie?}`. With `use_cookie: false` the refresh token is returned in the body. `403 signer_not_linked` → link the browser first. |
| POST | `/v1/auth/miniapp-quickauth` | none | Exchanges an `hqa1` token signed by a Mini App host wallet for a short-lived Juke JWT (≤ 1h, no refresh token). Body: `{token}`. Returns `{token, fid}`. |
| POST | `/v1/auth/signer/prepare` · `/v1/auth/signer/register` · `GET /v1/auth/signer/status` | none | One-time browser link: KeyGateway typed data to sign locally, relay, and poll. Use `signInWithPopup()` rather than calling these directly. |
| POST | `/v1/auth/refresh` | Bearer | Refresh Juke JWT. Reads the refresh token from `juke_refresh` cookie when present, or from the request body otherwise. |
| POST | `/v1/auth/logout` | none | Clears the `juke_refresh` cookie and revokes the refresh token in Redis. |

The SDK calls all of these for you. Reach for raw HTTP only if you
can't use the SDK (e.g., from a server, from a non-JS runtime).

## Developer API keys

Developer keys are only for server-side calls to protected Juke developer APIs. They are not needed for hosted iframes or normal anonymous listening.

End-to-end setup flow:

1. Open `https://juke.audio/developers`.
2. Sign in with Farcaster.
3. Request developer access.
4. Wait for Juke admin approval.
5. Create an app.
6. Create a key and copy the one-time secret immediately.
7. Store the secret on the server only, for example `JUKE_API_KEY`.
8. Embed hosted spaces without a key when the site only needs public listening.
9. Call protected Juke developer APIs from a backend process only.

Two distinct auth paths:

- **`/v1/developer/spaces`** (server-side room creation) is **key-only**. Send `X-Juke-Api-Key`; do not send a bearer JWT. The room owner is derived from the key's owning developer app.
- **`/v1/developer/apps/*`** (dashboard routes — list, create, rotate, revoke, reveal) require a bearer JWT scoped to the signed-in developer. Dangerous mutations additionally require a recent sign-in within 5 minutes (`401 Recent sign-in required.` + `WWW-Authenticate: ReAuth`). The dashboard handles this; server integrations rarely need these endpoints.

```ts
await fetch("https://your-api-host.example.com/v1/developer/spaces", {
  method: "POST",
  headers: {
    "X-Juke-Api-Key": process.env.JUKE_API_KEY!,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    title: "Weekly builder room",
    scheduled_at: null,
    announce_cast: false,
    allow_agents: true,
  }),
});
```

The room host is derived from the API key (the key's owning developer app's `owner_fid`). Never include a host identifier or host override in the request body.

If the request includes an `Origin` header and the developer app has `allowed_origins` configured, the Origin must match one of the listed entries. Server-to-server requests without an `Origin` header are not subject to this check.

Secret handling:

- Juke shows the API secret once at creation or rotation time.
- A short first-view reveal token may recover the secret during the initial view window.
- Lost secrets must be rotated.
- Never put `jk_sec_live_...` keys in browser JavaScript, mobile bundles, iframe URLs, public environment variables such as `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*`, client-side analytics, logs, crash reports, screenshots, or support transcripts.

Developer dashboard API:

```http
GET  /v1/developer/status
POST /v1/developer/application
GET  /v1/developer/apps
POST /v1/developer/apps
GET  /v1/developer/apps/{appId}/keys
POST /v1/developer/apps/{appId}/keys
POST /v1/developer/apps/{appId}/keys/{keyId}/reveal
POST /v1/developer/apps/{appId}/keys/{keyId}/rotate
POST /v1/developer/apps/{appId}/keys/{keyId}/revoke
GET  /v1/developer/apps/{appId}/bots
POST /v1/developer/spaces
GET  /v1/developer/spaces/{roomId}
POST /v1/developer/spaces/{roomId}/start
POST /v1/developer/spaces/{roomId}/end
POST /v1/developer/bots
GET  /v1/developer/bots/{botId}
POST /v1/developer/bots/{botId}/signer
DELETE /v1/developer/bots/{botId}
POST /v1/developer/webhooks
GET  /v1/developer/webhooks
GET  /v1/developer/webhooks/{webhookId}
DELETE /v1/developer/webhooks/{webhookId}
POST /v1/developer/partner-tokens
POST /v1/developer/rooms/{roomId}/agent-join
```

### Reads

`GET /v1/developer/spaces/{room_id}` returns room metadata + live participant list — use to reconcile after a missed webhook or to answer "who's here". Cross-app rooms 404. `GET /v1/developer/webhooks/{id}` returns a single subscription's state including `last_delivery_at`, `last_status`, `last_error`, `disabled_at` for introspection.

### Rate-limit + idempotency headers

Every key-authed response includes `X-Juke-Rate-Limit-Limit`, `X-Juke-Rate-Limit-Remaining`, and `X-Juke-Rate-Limit-Reset` so consumers can back off proactively. Every outbound webhook delivery carries `X-Juke-Idempotency-Key` (= `event_id`) so consumers can dedupe without parsing the body.

### Ending a room from your server

`POST /v1/developer/spaces/{room_id}/end` (key-auth, app's own rooms only) force-ends an active room and dispatches `room.finished` immediately — no waiting on LiveKit's 5-minute empty-room timeout. Cross-app rooms 404. Idempotent on already-ended rooms. For user-hosted native rooms (`host_mode == "user_fid"`), include a fresh `user_jfs_bearer` in the JSON body. Bot-hosted and Juke-hosted rooms need no body. The webhook payload carries `ended_via: "host" | "api" | "upstream"` — `"upstream"` means the reconciler observed the room end on Farcaster's side.

### Farcaster-native spaces from your server

Create rooms that appear in the Farcaster spaces carousel. Two host modes: bot-hosted (Juke holds the Ed25519 key) and user-hosted (fresh JFS bearer from the end user). `POST /v1/developer/spaces` with `"host": "farcaster"` plus exactly one of `host_bot_fid` or `user_jfs_bearer`; both/neither → 422.

**Bot signer setup (one-time):**
1. `POST /v1/developer/bots` with `{"fid": <int>, "label": "..."}` → Juke generates the key, returns `{id, signer_status: "pending_approval", approval_url, ready: false}`.
2. Bot account opens `approval_url` in Warpcast once. Wrong account → `fid_mismatch`; call `POST /v1/developer/bots/{id}/signer` to re-register with a fresh keypair (also recovers an expired 24 h deadline or a revoked key).
3. Poll `GET /v1/developer/bots/{id}` (≤ 1/30 s) until `ready: true`. `ready: true` is the single gate.

**Scheduled native rooms:** use `POST /v1/developer/spaces/{room_id}/start` to go live. User-hosted rooms require a fresh bearer in the body (fid must match host → 403). Idempotent; upstream 5xx → 502, room stays scheduled.

**Reading participants:** `GET /v1/developer/spaces/{room_id}` proxies the upstream Farcaster list. `is_muted` is always `false` (not observable). Header `X-Juke-Participants-Source: upstream|unavailable|juke` distinguishes empty rooms from read failures.

**Webhooks for native rooms:** `room.started` and `room.finished` fire with extra fields `is_farcaster_native`, `farcaster_room_id`, `host_mode`, `farcaster_host_fid`. `ended_via: "upstream"` fires when the reconciler observes the room end. `participant.joined/left` and `recording.ready` do NOT fire for native rooms — poll GET instead.

### Release feed for partner manifests

`GET https://juke.audio/changelog.json` returns a structured, CORS-open feed of shipped developer-facing changes. Each entry has an `id`, `shipped_at`, `endpoints`, `docs_section`, and an optional `resolves[]` list of partner-defined slugs. If your status page lists open asks against Juke, diff this feed against your manifest's `open_asks[].id` values to flip resolved items automatically — no markdown parsing required.

### Partner agents (free, scoped to your own rooms)

Approved developers can drop their own bot (note-taker, recap generator, etc.) into rooms they created without paying the x402 toll the public `/v1/rooms/{roomId}/agent-join` requires:

```ts
const res = await fetch(
  `https://your-api-host.example.com/v1/developer/rooms/${roomId}/agent-join`,
  {
    method: "POST",
    headers: {
      "X-Juke-Api-Key": process.env.JUKE_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ agent_name: "ZOE", agent_pfp_url: "https://..." }),
  },
);
const { session_token, livekit_token, livekit_ws_url } = await res.json();
```

Constraints: `room.created_by_app_id` must equal your app id (404 otherwise — cross-app rooms are indistinguishable from unknown UUIDs at this endpoint by design), `room.status === "active"`, `room.allow_agents === true`. Rate-limited 10/min + 100/day per key, with a per-room concurrent agent cap of 5 (returns 429 if you try to add a sixth). Returned `session_token` works identically to the paid path: re-call the same agent-join endpoint with `X-Session-Token` to rejoin or get a fresh `livekit_token`, and disconnect from LiveKit to leave. (`/v1/rooms/{roomId}/leave` and `/token` do not accept `X-Session-Token`.)

### Partner SSO bridge

When the embedding site has already signed the visitor in (SIWN, SIWE, custom session), pre-mint a short-lived Juke JWT from your server and pass it on the iframe URL so the visitor doesn't sign in again inside the embed.

```ts
const mint = await fetch("https://your-api-host.example.com/v1/developer/partner-tokens", {
  method: "POST",
  headers: {
    "X-Juke-Api-Key": process.env.JUKE_API_KEY!,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ fid: visitorFid, ttl_seconds: 300 }),
}).then((r) => r.json());

// Fragment, not query: it never reaches a server log or Referer header.
const src = `https://juke.audio/embed/${spaceId}#token=${encodeURIComponent(mint.token)}`;
```

`?token=` is still accepted but deprecated; use `#token=`. Either way the embed strips the token from its URL on load.

Trust model: possession of a valid Juke API key + the partner's assertion of `fid`. Damage from a leaked key is bounded by the TTL cap (≤ 10 min), the `partner_app_id` + `source="partner"` claims baked into every JWT, a two-tier per-key rate limit (60/min + 5,000/day), and a first-party gate on sensitive endpoints. No refresh token is issued — when the JWT expires, re-mint or fall back to Protocol Auth sign-in.

Partner JWTs are deliberately scoped to an existing **listener seat**: they are accepted only by `POST /v1/rooms/{spaceId}/leave` and `POST /v1/rooms/{spaceId}/token`, and only while that fid holds a listener seat in a room your app created (host, co-host and speaker seats, and other apps' rooms, get 403). Every other authenticated route, including `/join` and `/raise-hand`, requires a first-party Juke sign-in and rejects `source="partner"` JWTs with 401. A partner JWT is minted on your app's assertion of who the visitor is, so it never acts as that user anywhere else. Partner tokens are never issued for Juke admin accounts.

### Outbound webhooks

Subscribe a server URL to lifecycle events for any room your app created (rooms minted via `POST /v1/developer/spaces`).

Events and native-room caveats:
- `room.started` / `room.finished` — fire for native rooms too. Native payloads include `is_farcaster_native`, `farcaster_room_id`, `host_mode`, `farcaster_host_fid`. `ended_via` vocabulary is `"host" | "api" | "upstream"` (`"upstream"` = reconciler observed the room end on Farcaster's side).
- `participant.joined` / `participant.left` — **not emitted for native rooms**. Poll `GET /v1/developer/spaces/{room_id}` instead.
- `recording.ready` — **not emitted for native rooms**.

```ts
await fetch("https://your-api-host.example.com/v1/developer/webhooks", {
  method: "POST",
  headers: {
    "X-Juke-Api-Key": process.env.JUKE_API_KEY!,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    url: "https://your-app.example/juke-webhooks",
    events: ["room.finished", "recording.ready"],
  }),
});
```

The 201 response includes a one-time `secret` (prefixed `whsec_`). Store it server-side — it is never re-revealable; rotate by deleting + re-creating.

Deliveries are signed `X-Juke-Signature: t={ts},v1={hex_hmac}` over `f"{ts}.{raw_body}"` with HMAC-SHA256. Verify with `hmac.compare_digest` (constant time) and reject events older than ~5 minutes for replay protection. Use `event_id` for idempotency.

Retries: up to 4 attempts at t=0/+10s/+60s/+300s for non-2xx or transport failures, then stop. After 10 consecutive failures the subscription is auto-disabled. `last_error` exposed on `GET /v1/developer/webhooks` is a fixed vocabulary (`timeout | connection_failed | http_4xx | http_5xx | blocked_ip | dns_failure | …`) — never a raw exception or response body.

Webhook URLs must resolve to a globally-routable public IP. Loopback, link-local (including AWS/GCP IMDS at 169.254.169.254), private RFC1918, and other non-public ranges are rejected at delivery time with `last_error: blocked_ip`. Redirects are not followed.

Max 5 subscriptions per app, unique `(app_id, url)`.

### Shapes worth knowing

```ts
type JoinSpaceResponse = {
  livekit_token: string;       // ephemeral, scoped to role
  livekit_ws_url: string;
  expires_at?: string | null;
  role: "listener" | "speaker" | "co_host" | "host";
  room: Space;
  participants: SpaceParticipant[];
};
```

After `connectAudio()` runs, the SDK clears `livekit_token` from the join object to prevent accidental reuse. Don't try to read it back.

---

## Design constraints

These are the rules the iframe enforces and that custom SDK integrations are expected to honor. Each has a reason — explain the reason if a developer pushes back.

**Always keep visible:**
- Juke name or wordmark — so users know what they're using and can find it later
- "Powered by Juke" link — attribution back to juke.audio
- Host identity — the Farcaster account hosting the room
- Canonical space link or identity — so the room is shareable outside the embed

**Never:**
- Strip attribution from a free/public embed. The hosted backend is free precisely because attribution sends traffic back.
- Allow speaking without host promotion. The backend will reject the mic publish; doing it client-side just produces a worse UX.
- Allow reactions/replies/hand-raise for anonymous users. Same reason: backend rejects.
- Ask the user for Farcaster provider or LiveKit API keys. Third-party embeds never need provider keys.

**Brand palette** (use when matching the iframe's look):
- background `#0f0f23`
- surface `#151529` or `#1a1a2e`
- primary / live accent `#D85A30`
- sign-in accent `#855DCD`
- rounded corners, compact spacing, "live listening bar" feeling

---

## Common task recipes

Match the developer's request to one of these patterns. If their phrasing is ambiguous, ask once, then proceed.

### "Add a Juke space to my site"
1. Ask for the `spaceId` (Juke room UUID). If they don't have one yet, use a placeholder and tell them to swap it.
2. Paste Recipe 1 (hosted iframe).
3. Confirm HTTPS is in place (mic won't work otherwise).
4. Tell them: anonymous listening works immediately; Farcaster sign-in is optional and triggered when the user clicks a participate action.

### "I want my own UI for the space"
1. Recipe 2 (SDK).
2. Walk through the auth ladder — emphasize that listening must not require sign-in.
3. Render `participants` filtered by role for speakers (host, co_host, speaker).
4. Wire `onActiveSpeakersChanged` to a "now speaking" visual indicator.

### "How do I schedule a space?"
Two paths:
- iOS / hosts: schedule from the Juke app.
- Server-side: `POST /v1/developer/spaces` with `scheduled_at` (ISO 8601, UTC, ≥5 min in the future). Requires a developer API key — see the next section.

Before `scheduled_at`, `GET /v1/rooms/{spaceId}` returns 200 with `status: "scheduled"` and metadata only (no LiveKit token). The hosted embed at `/embed/{spaceId}` renders a live "starts in …" countdown automatically.

### "Can users record the space?"
No client-side recording in the embed. Recording is a host-side toggle (`POST /v1/rooms/{spaceId}/recording/start|stop`); the embed surfaces `room.recording` as read-only metadata. After the space ends and egress completes, the recording is addressable at `https://juke.audio/r/{spaceId}` (hosted web player with its own OG image) and via `GET /v1/recordings/{spaceId}` which returns a short-lived presigned `recording_url`.

### "Can I self-host the backend?"
Yes, but only worth it for compliance or air-gapped deployments. See the self-hosting section below.

### "Does this work in a Farcaster miniapp?"
Yes — use the SDK path and call `signInWithMiniApp()`; the host wallet signs a Protocol Auth token for the host's user. Register the embed origin in your miniapp manifest. The backend only accepts tokens whose domain is one it serves, so a Mini App on another domain needs that domain added to the backend's allowed audiences first.

### "Does this work in React Native?"
Use the SDK pattern (REST + LiveKit), but the LiveKit client is `@livekit/react-native`, not `livekit-client`. The HTTP calls are the same.

---

## Self-hosting (rare case)

Third-party embed consumers do **not** need any provider keys when using `https://juke.audio/embed/{spaceId}`. Skip this section unless the developer explicitly says they want to self-host the Juke backend.

If self-hosting, the backend needs:

```bash
DATABASE_URL=
REDIS_URL=
JWT_SECRET=
JWT_ALGORITHM=HS256
JWT_EXPIRY_HOURS=72
JWT_REFRESH_EXPIRY_DAYS=30
HYPERSNAP_HTTP_URL=https://haatz.quilibrium.com
OPTIMISM_RPC_URL=
KEY_RELAYER_PRIVATE_KEY=
SIGNER_ENCRYPTION_KEY=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_WS_URL=

# App custody account (used by miniapp auth-address registration and snap signing).
# User sign-in does not require these — the user's own key signs.
FARCASTER_APP_FID=
FARCASTER_APP_MNEMONIC=

# Domain required in legacy SIWF login messages (`/v1/auth/siwf/login`).
SIWF_DOMAIN=juke.audio

# Developer API key cryptography. Generate once per environment and back
# up in a secret manager — rotation is destructive (see below).
JUKE_API_KEY_PEPPER=          # ≥32 bytes random; peppers stored key hashes
JUKE_API_KEY_ENCRYPTION_KEY=  # exactly 32 bytes base64; AES-256-GCM key
JUKE_API_AUDIT_SECRET=        # ≥32 bytes random; HMAC for audit trail (optional)

# Domains accepted in Protocol Auth tokens (web and Mini App sign-in). Must
# include the origin where the SDK is embedded.
QUICKAUTH_ALLOWED_AUDIENCES=juke.audio
CORS_ORIGINS='["https://your-domain"]'
ENVIRONMENT=production        # enables Secure cookies + strict secret length checks
```

The Next.js landing/embed needs:

```bash
NEXT_PUBLIC_API_BASE_URL=https://api.your-domain
NEXT_PUBLIC_SITE_URL=https://your-domain
```

LiveKit can be self-hosted or use LiveKit Cloud. Point `HYPERSNAP_HTTP_URL` at any Hypersnap node — Farcaster identity is the auth substrate.

**Do not rotate** `JUKE_API_KEY_PEPPER` or `JUKE_API_KEY_ENCRYPTION_KEY`
without a planned migration. Pepper rotation invalidates every stored
API key hash (every developer's keys stop working). Encryption key
rotation makes every un-revealed secret undecryptable. Treat both as
primary key material.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Iframe shows "Space not found" | Wrong spaceId or room ended | Verify the UUID and `room.status === "active"` |
| No audio after clicking Listen | Browser blocked autoplay | The embed unlocks audio on user gesture — make sure the click handler isn't wrapped in something that breaks the gesture chain |
| `enableMicrophone` throws | User isn't a speaker yet | Host must promote them via the Juke app |
| `signInWithMiniApp()` returns `null` | Not inside a Mini App host, or the host exposes no wallet | Expected on ordinary webpages — offer the web flow (`signInWithPopup()` from a click) |
| `signInWithMiniApp()` throws `JukeEmbedAuthError` | Check `error.reason`: `user_cancelled` (the visitor declined), `network` / `timeout` (retry), `verify_failed` (the host wallet can't sign for this account) | Fall back to the web flow only on `verify_failed` |
| `signInWithPopup()` rejects with `reason: "blocked"` | The browser blocked the window, it wasn't called from a click, or a sandboxed iframe lacks `allow-popups` | Call it directly in the click handler; add `allow-popups` to the iframe sandbox |
| `signInWithMiniApp()` throws "…wallet couldn't sign in for this account…" | `/v1/auth/miniapp-quickauth` returned 401: the host wallet is neither the FID's custody address nor a linked auth address, or the token's domain/chain is not accepted | Fall back to the web flow; it works for any account |
| Web sign-in asks for the recovery phrase in the juke.audio window | This browser has no auth address linked on juke.audio yet (or site data was cleared) | Expected once per browser; later sign-ins reuse the stored key |
| Reactions silently fail | Not authenticated | `sendReaction` throws `JukeEmbedAuthError` — gate the UI on `sdk.isAuthenticated` |
| Mic permission prompt appears too early | UI requested mic before host promotion | Move `enableMicrophone(true)` behind the post-promotion "Unmute" button only |

---

## What this skill will NOT do

- Generate Juke spaceIds. The developer must supply one.
- Provide Farcaster provider or LiveKit credentials.
- Bypass host promotion for speaking.
- Strip Juke attribution.
- Document features that aren't shipped (e.g., URL-based mode/participation overrides).
