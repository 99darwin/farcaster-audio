---
name: juke-spaces-embed
description: Embed live Farcaster audio spaces (Juke) into a website, miniapp, or React app. Use this skill whenever a developer wants to add live audio rooms, voice chat, persistent audio, Twitter/X Spaces–style rooms, Clubhouse-style rooms, listener-only audio streams, host-approved speaking, hand-raise queues, audio reactions, or any Farcaster-native audio social feature — even if they don't say the word "Juke". Two integration paths exist: a hosted iframe (zero-config) and a JavaScript SDK (custom UI). Trigger this skill for prompts like "add audio rooms to my site", "embed a live space", "add voice chat with Farcaster sign-in", "ship a Twitter Spaces clone", "let users listen to a live room on my landing page", or any request that involves real-time audio rooms tied to Farcaster identity.
---

# Juke Spaces Embed

Juke is a hosted backend + LiveKit-based audio service for Farcaster-native live audio rooms ("spaces"). This skill helps you ship a Juke space inside a website, miniapp, or React app.

There are three integration layers over the same room model. Pick the lightest one that works:

- **Hosted iframe** — paste one `<iframe>` tag. Juke renders the whole UI. Auth, LiveKit, attribution, updates, mic permissions: all handled.
- **SDK / custom UI** — your code calls Juke's API and drives LiveKit directly. You render your own design system.
- **Developer API keys** — server-side integrations for protected Juke developer APIs. These require Juke approval and a server-held secret key.

Neither iframe nor SDK is mandatory. Default to the iframe unless the developer signals they want custom UI. Do not ask developers for Neynar or LiveKit keys.

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
- "Sign in to participate" via SIWF (QR + mobile deeplink)
- reactions, hand raise, mic (after host promotion)
- LiveKit connection and reconnection
- Juke attribution

No Juke developer API key is required for hosted iframes.

Notes:
- `autoplay` is needed so audio starts after the listener clicks "Listen". Browsers gate autoplay behind a user gesture, which the iframe handles internally.
- `microphone` is only required if the listener may eventually speak. You can omit it for listen-only deployments, but the iframe will still render the participate buttons in disabled state — better to include `microphone` and let the host's promotion model gate actual mic publishing.
- HTTPS is mandatory for mic access in browsers.
- The iframe is intentionally narrow (≈ 480px). It's designed to live in a sidebar, modal, or single-column page.

If the developer asks for `mode=compact` or `participation=listen` URL params, use them only when the hosted embed page documents support for that deployment. The safe default is the full participate UI with anonymous listening and optional sign-in.

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
import QRCode from "qrcode"; // any QR library works
import {
  createJukeEmbedSdk,
  type JukeEmbedSdk,
} from "@/lib/juke-embed-sdk";
import type { JoinSpaceResponse } from "@/lib/spaces";

export function MySpace({ spaceId }: { spaceId: string }) {
  const sdkRef = useRef<JukeEmbedSdk>();
  const signerAbortRef = useRef<AbortController | null>(null);
  const [join, setJoin] = useState<JoinSpaceResponse | null>(null);
  const [isAuthed, setIsAuthed] = useState(false);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  if (!sdkRef.current) sdkRef.current = createJukeEmbedSdk();

  // 1. Anonymous listening — no sign-in required.
  async function listen() {
    const j = await sdkRef.current!.joinAnonymousListener(spaceId);
    await sdkRef.current!.connectAudio(j);
    setJoin(j);
  }

  // 2. Sign In With Farcaster (SIWF): backend issues a nonce, the SDK
  //    opens a SIWF channel via the Farcaster auth relay, and returns
  //    a `farcaster://connect` deeplink the user approves in their
  //    Farcaster client. The signed message includes our domain.
  async function signIn() {
    // Cancel any previous in-flight attempt.
    signerAbortRef.current?.abort();
    const abort = new AbortController();
    signerAbortRef.current = abort;

    const { channelToken, url } = await sdkRef.current!.startSiwfFlow();
    setApprovalUrl(url);

    // Render the SIWF deeplink as a QR for desktop scan. Mobile users
    // tap the "I'm on my mobile device" link instead.
    QRCode.toDataURL(url).then(setQrDataUrl);

    try {
      // 3. Poll until the user approves in their Farcaster client.
      const approved = await sdkRef.current!.pollSiwfStatus(channelToken, {
        signal: abort.signal,
      });

      // 4. Complete login and join as an authenticated participant.
      await sdkRef.current!.completeSiwfLogin({
        message: approved.message,
        signature: approved.signature,
      });
      const j = await sdkRef.current!.joinAuthenticated(spaceId);
      await sdkRef.current!.connectAudio(j);

      setApprovalUrl(null);
      setQrDataUrl(null);
      setJoin(j);
      setIsAuthed(true);
    } catch (err) {
      if (!abort.signal.aborted) throw err;
    } finally {
      if (signerAbortRef.current === abort) signerAbortRef.current = null;
    }
  }

  function cancelSignIn() {
    signerAbortRef.current?.abort();
    signerAbortRef.current = null;
    setApprovalUrl(null);
    setQrDataUrl(null);
  }

  // Clean up the audio connection on unmount.
  useEffect(() => () => {
    signerAbortRef.current?.abort();
    sdkRef.current?.leaveSpace().catch(() => {});
  }, []);

  // 5. Authenticated actions.
  const react = () => sdkRef.current!.sendReaction("clap");
  const raiseHand = () => sdkRef.current!.raiseHand(spaceId, true);
  const speak = () => sdkRef.current!.enableMicrophone(true); // throws unless host promoted

  return (
    <div>
      {!join && <button onClick={listen}>Listen</button>}
      {join && !isAuthed && !approvalUrl && (
        <button onClick={signIn}>Sign in to participate</button>
      )}
      {approvalUrl && (
        <div>
          {qrDataUrl && <img src={qrDataUrl} alt="Scan with Farcaster" />}
          <a href={approvalUrl} target="_blank" rel="noopener noreferrer">
            I&apos;m on my mobile device
          </a>
          <button onClick={cancelSignIn}>Cancel</button>
        </div>
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

### Why SIWF (not a managed signer)

Juke uses [Sign In With Farcaster (SIWF)](https://docs.farcaster.xyz/developers/siwf) — Farcaster's EIP-4361 / SIWE-based auth flow — to authenticate web users. We previously shipped Neynar's `createSigner + registerSignedKey` "managed signer" pattern; we migrated off it because SIWF is purpose-built for *authentication* (proving FID ownership) and has a security property the managed-signer flow lacks: **the signed message includes the requesting `domain`, and the Farcaster client displays that domain to the user at approval time.**

That domain binding is what closes the QR-phishing window. A victim scanning a QR generated by `evil.com` sees `evil.com wants you to sign in` in their Farcaster client — not just the registered app name. They can refuse before approving. The managed-signer flow couldn't surface the origin because the SignedKeyRequest EIP-712 schema has no slot for one.

How it works in the SDK:

- `startSiwfFlow()` — gets a server-issued nonce from `/v1/auth/siwf/nonce`, asks the Farcaster auth relay (`relay.farcaster.xyz`) to open a channel, returns `{ channelToken, url }`. The url is a `farcaster://connect?channelToken=...` deeplink.
- `pollSiwfStatus(channelToken, { signal })` — waits via `@farcaster/auth-client` until the user approves and the relay returns the signed SIWE message + signature.
- `completeSiwfLogin({ message, signature })` — POSTs to our backend, which cryptographically verifies the signature, confirms domain + nonce, resolves the recovered custody address → FID via Neynar, and mints a Juke JWT.

Render the `url` as a QR (desktop) plus a tap-to-deeplink button (mobile). Both code paths trigger the same Farcaster client approval screen which displays the domain.

### Inside a Farcaster miniapp

Skip SIWF and use Farcaster Quick Auth (the `@farcaster/miniapp-sdk` client). Exchange the miniapp JWT for a Juke JWT via the backend's miniapp login route. The SDK's `joinAuthenticated(spaceId)` works the same way once you've set the auth session.

### Inside the native Juke iOS app

Use the app's own on-device auth-address flow (separate from SIWF — the iOS app generates a secp256k1 keypair on-device and registers it via Neynar's developer-managed signed key API). Don't pop a web popup or render a QR inside a React Native WebView.

---

## Auth ladder (the most important rule)

Follow this order. It exists because requiring sign-in before listening is the single biggest reason audio embeds get abandoned by anonymous web visitors:

1. **Render room metadata without auth.** Title, host, listener count, status — all public.
2. **Let visitors listen anonymously.** One click, no popup, no sign-in.
3. **Prompt "Sign in to participate" only when they try to interact.** Reactions, replies, hand raise.
4. **Choose the right auth method for the context:**
   - Ordinary webpage → SIWF (QR scan + mobile deeplink)
   - Farcaster miniapp → Quick Auth
   - Native iOS app → on-device auth-address (Neynar developer-managed signed key API)
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

## Security considerations: domain binding

The SIWF flow (`startSiwfFlow` → user approves in Farcaster → `pollSiwfStatus` → `completeSiwfLogin`) is built on EIP-4361 (Sign In With Ethereum), adapted by Farcaster as Sign In With Farcaster. The signed message includes the requesting **domain** as a first-class field, and the Farcaster client displays that domain on the approval screen. This closes the QR-phishing class of attacks that affected the prior managed-signer flow.

**How the trust boundary works.** When the SDK starts a sign-in, it constructs a SIWE message with `domain = window.location.hostname` and submits it through Farcaster's auth relay. The user's Farcaster client renders an approval screen that names the exact domain that issued the request. A QR generated by `juke-audio.com` will show `juke-audio.com` at approval — not `juke.audio`. The user sees, in their trusted Farcaster client, the actual origin they are about to authenticate to.

**Server-side verification.** On `/v1/auth/siwf/login` the backend re-parses the signed message, checks the signature against the user's Farcaster custody address (via Neynar's bulk-by-address lookup), and verifies that the message's `domain` and `nonce` match what the backend issued. A signature that authenticated to a different domain will not validate against `juke.audio`.

**Defense-in-depth still in place:**

- **Single-use nonces** — every login burns a server-issued nonce (10-minute TTL). Replays fail.
- **Per-IP rate limits** — 30/min on `/v1/auth/siwf/nonce`, 10/min on `/v1/auth/siwf/login`.
- **Custody-address binding** — the fid is resolved from the signature's recovered address through Neynar, not provided by the client.

**What integrators should do.** Render the SIWF QR/deeplink inside the same browser context that the user trusts. The Farcaster client will surface that origin to the user at approval, so the only requirement is that your embedding domain truthfully represents the experience.

**Reference.** Farcaster's SIWF specification: [docs.farcaster.xyz/developers/siwf](https://docs.farcaster.xyz/developers/siwf).

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
| POST | `/v1/auth/siwf/nonce` | none | Issues a single-use SIWE nonce (10-minute TTL). Rate-limited 30/min per IP. |
| POST | `/v1/auth/siwf/login` | none | Verifies a signed SIWF message and exchanges it for a Juke JWT. Body: `{message, signature, use_cookie?}`. Accepts `use_cookie: true` to set an HttpOnly refresh cookie instead of returning the refresh token in the body. Rate-limited 10/min per IP. |
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
- **`/v1/developer/apps/*`** (dashboard routes — list, create, rotate, revoke, reveal) require a bearer JWT scoped to the signed-in developer. Dangerous mutations additionally require a recent SIWF sign-in within 5 minutes (`401 Recent sign-in required.` + `WWW-Authenticate: ReAuth`). The dashboard handles this; server integrations rarely need these endpoints.

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
POST /v1/developer/spaces
```

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
- Ask the user for Neynar or LiveKit API keys. Third-party embeds never need provider keys.

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
Out of scope for the embed skill. Spaces are created via the Juke iOS app or the host-facing API (not yet public). The embed is consumption-only.

### "Can users record the space?"
No client-side recording in the embed. Recording is a host-side setting on the room (`room.recording`); the embed surfaces it as read-only metadata.

### "Can I self-host the backend?"
Yes, but only worth it for compliance or air-gapped deployments. See the self-hosting section below.

### "Does this work in a Farcaster miniapp?"
Yes — use the SDK path, swap SIWF for Quick Auth, register the embed origin in your miniapp manifest.

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
NEYNAR_API_KEY=
NEYNAR_CLIENT_ID=
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_WS_URL=

# App custody account (used by miniapp auth-address registration and snap signing).
# SIWF login does not require these — the user's own Farcaster custody signs.
FARCASTER_APP_FID=
FARCASTER_APP_MNEMONIC=

# SIWF domain the backend will require in signed messages. Must match the
# origin where the SDK is embedded (e.g. juke.audio, or your hosted domain).
SIWF_DOMAIN=juke.audio

# Developer API key cryptography. Generate once per environment and back
# up in a secret manager — rotation is destructive (see below).
JUKE_API_KEY_PEPPER=          # ≥32 bytes random; peppers stored key hashes
JUKE_API_KEY_ENCRYPTION_KEY=  # exactly 32 bytes base64; AES-256-GCM key
JUKE_API_AUDIT_SECRET=        # ≥32 bytes random; HMAC for audit trail (optional)

QUICKAUTH_ALLOWED_AUDIENCES=juke.audio
CORS_ORIGINS='["https://your-domain"]'
ENVIRONMENT=production        # enables Secure cookies + strict secret length checks
```

The Next.js landing/embed needs:

```bash
NEXT_PUBLIC_API_BASE_URL=https://api.your-domain
NEXT_PUBLIC_SITE_URL=https://your-domain
```

LiveKit can be self-hosted or use LiveKit Cloud. Neynar can't be swapped — Farcaster identity is the auth substrate.

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
| QR shows but never resolves | User hasn't approved in their Farcaster client, or the channel expired | Surface the `farcaster://connect` deeplink as a fallback; user can re-trigger `startSiwfFlow()` to mint a fresh channel |
| `pollSiwfStatus` throws "Sign-in cancelled" | The AbortController was triggered | Expected when the user cancels — swallow the rejection if `signal.aborted` |
| `/v1/auth/siwf/login` returns 400 "invalid_nonce" or "domain_mismatch" | Message domain doesn't match the embedding origin, or the nonce was already used / expired | Re-run `startSiwfFlow()` to get a fresh nonce + channel |
| Reactions silently fail | Not authenticated | `sendReaction` throws `JukeEmbedAuthError` — gate the UI on `sdk.isAuthenticated` |
| Mic permission prompt appears too early | UI requested mic before host promotion | Move `enableMicrophone(true)` behind the post-promotion "Unmute" button only |

---

## What this skill will NOT do

- Generate Juke spaceIds. The developer must supply one.
- Provide Neynar or LiveKit credentials.
- Bypass host promotion for speaking.
- Strip Juke attribution.
- Document features that aren't shipped (e.g., URL-based mode/participation overrides).
