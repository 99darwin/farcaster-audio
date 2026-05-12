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
- "Sign in to participate" via SIWN popup
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
import {
  createJukeEmbedSdk,
  isTrustedSiwnMessage,
  parseSiwnPayload,
  type JukeEmbedSdk,
} from "@/lib/juke-embed-sdk";
import type { JoinSpaceResponse } from "@/lib/spaces";

export function MySpace({ spaceId }: { spaceId: string }) {
  const sdkRef = useRef<JukeEmbedSdk>();
  const [join, setJoin] = useState<JoinSpaceResponse | null>(null);
  const [isAuthed, setIsAuthed] = useState(false);

  if (!sdkRef.current) sdkRef.current = createJukeEmbedSdk();

  // 1. Anonymous listening — no sign-in required.
  async function listen() {
    const j = await sdkRef.current!.joinAnonymousListener(spaceId);
    await sdkRef.current!.connectAudio(j);
    setJoin(j);
  }

  // 2. Sign in only when the user opts into participation.
  async function signIn() {
    await sdkRef.current!.startSiwn(); // opens popup
    // The popup posts a message back when the user finishes SIWN.
    // The listener below picks it up.
  }

  // 3. Handle the SIWN postMessage callback.
  useEffect(() => {
    const handler = async (event: MessageEvent) => {
      if (!isTrustedSiwnMessage(event)) return;
      const payload = parseSiwnPayload(event.data);
      if (!payload) return;

      await sdkRef.current!.completeSiwn(payload);
      const j = await sdkRef.current!.joinAuthenticated(spaceId);
      await sdkRef.current!.connectAudio(j);
      setJoin(j);
      setIsAuthed(true);
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      sdkRef.current?.leaveSpace().catch(() => {});
    };
  }, [spaceId]);

  // 4. Authenticated actions.
  const react = () => sdkRef.current!.sendReaction("clap");
  const raiseHand = () => sdkRef.current!.raiseHand(spaceId, true);
  const speak = () => sdkRef.current!.enableMicrophone(true); // throws unless host promoted

  return (
    <div>
      {!join && <button onClick={listen}>Listen</button>}
      {join && !isAuthed && <button onClick={signIn}>Sign in to participate</button>}
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

### Why SIWN uses postMessage, not a callback URL

Juke opens the SIWN popup at a Neynar-hosted URL. When the user signs in, the popup posts a message back to the opener window with `{ fid, signer_uuid }`. The SDK exports `isTrustedSiwnMessage()` and `parseSiwnPayload()` so you can validate the origin and shape before calling `completeSiwn()`. Always validate — the popup origin is whitelisted to Neynar/Warpcast/your own origin only.

### Inside a Farcaster miniapp

Skip SIWN. Use Farcaster Quick Auth (the `@farcaster/miniapp-sdk` client). Exchange the miniapp JWT for a Juke JWT via the backend's miniapp login route. The SDK's `joinAuthenticated(spaceId)` works the same way once you've set the auth session.

### Inside the native Juke iOS app

Use the app's own Neynar SIWN flow. Don't pop a web popup inside a React Native WebView — handle SIWN natively and inject the resulting auth session.

---

## Auth ladder (the most important rule)

Follow this order. It exists because requiring sign-in before listening is the single biggest reason audio embeds get abandoned by anonymous web visitors:

1. **Render room metadata without auth.** Title, host, listener count, status — all public.
2. **Let visitors listen anonymously.** One click, no popup, no sign-in.
3. **Prompt "Sign in to participate" only when they try to interact.** Reactions, replies, hand raise.
4. **Choose the right auth method for the context:**
   - Ordinary webpage → SIWN popup
   - Farcaster miniapp → Quick Auth
   - Native iOS app → native Neynar SIWN
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

## API surface (REST)

Base URL: `https://your-api-host.example.com`

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/v1/rooms/{spaceId}` | none | Public room metadata + participant list |
| POST | `/v1/rooms/{spaceId}/anonymous-join` | none | Listener-only LiveKit token |
| POST | `/v1/rooms/{spaceId}/join` | Bearer | Authenticated join, role-scoped LiveKit token |
| POST | `/v1/rooms/{spaceId}/leave` | Bearer | Mark left, clean up participant row |
| POST | `/v1/rooms/{spaceId}/token` | Bearer | Refresh expiring LiveKit token |
| POST | `/v1/rooms/{spaceId}/raise-hand` | Bearer | Toggle hand-raise (`{"raised": bool}`) |
| GET | `/v1/auth/neynar-auth-url` | none | SIWN authorization URL |
| POST | `/v1/auth/login` | none | Exchange `{fid, signer_uuid}` for Juke JWT |
| POST | `/v1/auth/refresh` | Bearer | Refresh Juke JWT |

The SDK calls all of these for you. Reach for raw HTTP only if you can't use the SDK (e.g., from a server, from a non-JS runtime).

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

Protected developer API calls use both a Juke user/session bearer token and the server-held Juke API key:

```ts
await fetch("https://your-api-host.example.com/v1/developer/spaces", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.JUKE_USER_TOKEN}`,
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

The bearer token determines the room host. Never include a host identifier or any host override in developer API requests.

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
Yes — use the SDK path, swap SIWN for Quick Auth, register the embed origin in your miniapp manifest.

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
QUICKAUTH_ALLOWED_AUDIENCES=juke.audio
CORS_ORIGINS='["https://your-domain"]'
```

The Next.js landing/embed needs:

```bash
NEXT_PUBLIC_API_BASE_URL=https://api.your-domain
NEXT_PUBLIC_SITE_URL=https://your-domain
```

LiveKit can be self-hosted or use LiveKit Cloud. Neynar can't be swapped — Farcaster identity is the auth substrate.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Iframe shows "Space not found" | Wrong spaceId or room ended | Verify the UUID and `room.status === "active"` |
| No audio after clicking Listen | Browser blocked autoplay | The embed unlocks audio on user gesture — make sure the click handler isn't wrapped in something that breaks the gesture chain |
| `enableMicrophone` throws | User isn't a speaker yet | Host must promote them via the Juke app |
| SIWN popup blocked | Popup blocker | `startSiwn()` returns `popup: null` — surface a "click here to retry" affordance |
| Reactions silently fail | Not authenticated | `sendReaction` throws `JukeEmbedAuthError` — gate the UI on `sdk.isAuthenticated` |
| Mic permission prompt appears too early | UI requested mic before host promotion | Move `enableMicrophone(true)` behind the post-promotion "Unmute" button only |

---

## What this skill will NOT do

- Generate Juke spaceIds. The developer must supply one.
- Provide Neynar or LiveKit credentials.
- Bypass host promotion for speaking.
- Strip Juke attribution.
- Document features that aren't shipped (e.g., URL-based mode/participation overrides).
