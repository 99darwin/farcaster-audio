# Backend network limits

This page covers how the API works out who a client is, and the
abuse/DoS limits that depend on it. All of these settings are optional
environment variables on the backend service. The defaults are chosen so
that a deploy with none of them set behaves safely.

## Client IP and `TRUSTED_PROXY_IPS`

Every per-IP rate limit and dedupe key comes from one helper,
`app/services/client_ip.py::client_ip`. It reads `X-Forwarded-For` and
`X-Real-IP` **only** when the TCP peer (`request.client.host`) is a trusted
proxy. In every other case the peer address is the client, so an internet
client can't choose its own rate-limit bucket by sending a forged header.

IPv6 clients are bucketed by their `/64` (returned as e.g.
`2001:db8::/64`), because any IPv6 client controls at least a /64 and
could otherwise rotate addresses to escape every per-IP limit.

When the peer is trusted, the helper walks `X-Forwarded-For` from right to
left and skips trusted hops. The first untrusted address is the client.
Entries to its left were written by the client and are ignored. If no such
address exists, the helper falls back to `X-Real-IP`, then to the peer.

| `TRUSTED_PROXY_IPS` | Behaviour |
|---|---|
| unset / empty (default) | Trust peers in loopback, RFC 1918 (`10/8`, `172.16/12`, `192.168/16`), Railway's proxy range `100.0.0.0/8` (which includes CGNAT `100.64/10`), `::1`, and IPv6 ULA `fc00::/7`. |
| `10.0.0.0/8,fd12::/16` | Trust only these comma-separated CIDRs or addresses. |
| `none` | Never read forwarding headers. Use this only when the API is exposed directly with no proxy. |

An invalid entry fails startup, so a typo can't silently widen or drop
trust. If the value is unset in `ENVIRONMENT=production`, the app logs a
**warning** at startup and keeps running.

### Deployment assumptions

- **Railway (production).** `railway.json` builds the root `Dockerfile`,
  which runs bare `uvicorn` with no `--proxy-headers` and no nginx.
  Railway's edge proxy connects to the container from `100.0.0.0/8`
  (Railway's published guidance) or a private IPv6 address. Nothing else
  can reach the container's socket. The edge appends the real client to
  `X-Forwarded-For` and sets `X-Real-IP`. The default trust set covers
  this, so no configuration is needed.
  - **Verify after deploy.** Railway's CDN can add its own public hop as
    the rightmost `X-Forwarded-For` entry. If that happens, the right-to-left
    walk stops at the CDN hop, and clients share its bucket. Check one
    request's peer and `X-Forwarded-For`. If a CDN hop shows up, add its
    range to `TRUSTED_PROXY_IPS` (along with the defaults).
  - Before this change, some routes keyed limits on the peer address. That
    put every anonymous user into one shared bucket: the edge's.
- **`backend/docker-compose.prod.yml` + `backend/nginx.conf`.** nginx runs
  in its own container on the Docker bridge (`172.16.0.0/12`). It sets
  `X-Real-IP $remote_addr` and `X-Forwarded-For $proxy_add_x_forwarded_for`.
  This is also covered by the default.
  - nginx caps bodies at `client_max_body_size 10M`, which is lower than
    the 50 MB video upload limit. Raise it for `/v1/media/upload` if this
    path is used for video.
- **A CDN or WAF in front of the edge** (Cloudflare, etc.). Its addresses
  are public, so they are *not* trusted by default, and every client would
  resolve to the CDN's address. Add the CDN's published ranges to
  `TRUSTED_PROXY_IPS`, together with the private ranges above.
  - The app logs a one-time warning when an untrusted peer sends forwarding
    headers. That warning is the symptom to look for.

## Request body cap

`app/middleware/body_size.py` sets a global body ceiling, applied by path
prefix. The longest matching prefix wins. A declared `Content-Length` over
the limit gets a 413 before anything is read. Chunked or streamed bodies
are cut off with a 413 as soon as they pass the limit.

| Path prefix | Limit |
|---|---|
| `/v1/media/upload` | 51 MB (50 MB video plus multipart framing) |
| everything else | 2 MB |

Route handlers can enforce tighter caps; webhooks do. `POST
/v1/media/upload` now authenticates the caller and checks its per-fid
limit **before** it parses the multipart body.

## Redis connection pool

| Variable | Default | Notes |
|---|---|---|
| `REDIS_MAX_CONNECTIONS` | 500 | Command pool ceiling per process (HTTP handlers, workers). This used to be unbounded. |
| `REDIS_PUBSUB_MAX_CONNECTIONS` | 2000 | Separate pool for websocket pubsub: one connection per open socket. When it's full, new sockets are refused, and HTTP is unaffected. |
| `REDIS_POOL_TIMEOUT_SECONDS` | 5 | How long a request waits for a free connection before it errors. |

Keep `REDIS_PUBSUB_MAX_CONNECTIONS` above peak concurrent websockets, and
keep the sum of both pools below the Redis server's `maxclients` divided by
the number of API processes.

## Websocket caps

| Variable | Default | Socket |
|---|---|---|
| `MESSAGES_WS_MAX_PER_FID` | 5 | `WS /v1/messages/events`. Over the cap, the socket is closed with code `4429`, reason `too_many_connections`. |
| `ROOM_EVENTS_WS_MAX_PER_IP` | 100 | `WS /v1/rooms/events` (unauthenticated). Over the cap, the handshake is refused before accept. |

Caps are Redis sorted-set leases. Open sockets renew them, and they expire
on their own (60 s for messages, 90 s for rooms), so a crashed worker can't
leave a fid or IP locked out. `/v1/messages/events` also closes live
sockets with code `4404`, reason `messaging_disabled`, within one poll
interval of `MESSAGING_ENABLED` being turned off.

## Per-route rate limits

| Route | Key | Limit |
|---|---|---|
| `POST /v1/feed/cast` | fid | 20/min, 500/day (space chat replies post through this route) |
| `POST /v1/feed/cast/thread` | fid (publish bucket) | 5/min |
| `GET /v1/feed/cast/thread` | fid (read bucket) | 120/min |
| `GET /v1/feed/og` | fid (Redis) | 15/min |
| `POST /v1/media/upload` | fid | 20/min, 300/day |
| `GET /v1/auth/miniapp-nonce` | client IP | 120/min |
| `/v1/farcaster-spaces/*` | fid | 240/min across all routes |
| `POST /v1/voice-notes/{id}/plays` (anonymous) | client IP | 120/hour, plus 1 play per note per IP per 24 h |
| `POST /v1/voice-notes/{id}/plays` (signed in) | fid | 1 play per note per 60 s |

`listened_ms` on a play is capped at 120 000 by the schema, then clamped to
the note's real duration before it is stored.

`/health` returns only `{"status": "ok" | "degraded"}`.
