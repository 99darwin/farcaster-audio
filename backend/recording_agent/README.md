# Juke recording-agent worker

Out-of-process Node worker that joins a Farcaster-native LiveKit room
as a passive listener, mixes every subscribed audio track, and streams
the mixed OGG/Opus to S3 via multipart upload.

Owned by `app/services/recording_agent_service.py` — the Python side
holds the subprocess lifecycle (spawn / SIGTERM / finalize / cleanup).
This package is intentionally self-contained: a separate `package.json`
keeps its dependencies out of the rest of the repo.

## Wire protocol

The worker reads **one** JSON line on stdin:

```json
{
  "recording_id": "abc123...",
  "signaling_url": "wss://livekit.farcaster.xyz",
  "token": "<LiveKit JWT for the agent FID>",
  "room_id": "<Farcaster room id>",
  "s3_target": "recordings/{room_id}/native-{ts}.ogg"
}
```

It writes JSON-line events to stdout:

| Event | Meaning |
|---|---|
| `{"event":"started"}` | Connected to LiveKit + ffmpeg spawned. |
| `{"event":"progress","bytes":N}` | Periodic upload progress (every 10s). Optional. |
| `{"event":"finalized","url":"https://..."}` | Graceful stop. Process exits 0 after. |
| `{"event":"error","message":"..."}` | Fatal failure. Process exits non-zero. |

On `SIGTERM` (or upstream `Disconnected`), the worker drains the mixer,
flushes ffmpeg, waits for the S3 multipart to finalize, then emits
`finalized` and exits 0.

## Deploy requirements

* **Node ≥ 20** — uses native ESM + `node:test`.
  `@livekit/rtc-node` ships prebuilt N-API binaries for darwin-arm64,
  darwin-x64, linux-x64, linux-arm64. Other targets need source build.
* **ffmpeg ≥ 4.4 in `$PATH`** — must be compiled with `libopus`. On
  Debian: `apt-get install -y ffmpeg`. On Alpine: `apk add ffmpeg`.
* **S3 credentials in env** — the AWS SDK's default chain picks up
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` or an instance role.
  We never log or echo these.
* **S3 routing env**:
  * `AWS_S3_BUCKET_NAME` — required, bucket the recording lands in.
  * `AWS_DEFAULT_REGION` (or `AWS_REGION`) — required.
  * `AWS_ENDPOINT_URL` — optional. When set, the SDK uses path-style
    addressing (matches the egress fallback's `force_path_style=True`).

The bucket / region / endpoint come from the environment, not the JSON
payload — the Python orchestrator stays storage-agnostic.

## Local smoke test

```sh
echo '{
  "recording_id":"rec-test",
  "signaling_url":"wss://example.invalid",
  "token":"fake-jwt",
  "room_id":"rm-test",
  "s3_target":"recordings/rm-test/smoke.ogg"
}' | AWS_S3_BUCKET_NAME=test-bucket AWS_DEFAULT_REGION=us-east-1 node worker.mjs
```

The worker will fail to connect to LiveKit (the URL is invalid) and
emit an `{"event":"error",...}` line. That's the smoke happy path —
it proves the JSON wire protocol roundtrips and the binary loads.

For an end-to-end test against a real room, see
`backend/tests/test_recording_agent_service.py` and the integration
runbook below.

## Production concerns

* **ffmpeg memory** — Opus encoding at 32 kbps mono is ~5 MB resident.
  A 100-room SFU can host many concurrent recordings safely; the
  bottleneck is LiveKit egress bandwidth, not the encoder.
* **S3 multipart timeout** — `lib-storage` uses default SDK retry +
  timeout config. Long rooms (6+ h) should set `AWS_RETRY_MODE=standard`
  and `AWS_MAX_ATTEMPTS=5` in deploy env if multipart parts fail more
  than rarely.
* **LiveKit reconnect** — `@livekit/rtc-node` reconnects automatically
  on transient disconnects. A hard `Disconnected` event (room deleted,
  upstream finished) triggers graceful finalize so we keep whatever
  audio we already have.
* **ffmpeg dies mid-stream** — surfaces through the shared error path
  and finalizes the partial upload before exiting non-zero. The Python
  side gets `{"event":"error", ...}` and clears state.

## Testing

```sh
cd backend/recording_agent
npm test            # node --test __tests__/worker.test.mjs
```

Covers:

* `mixFrames` — saturating int16 sum.
* `readFirstStdinLine` — JSON-line parsing edge cases.
* `buildRecordingUrl` — path-style + virtual-hosted format.
* CLI smoke — wire protocol behavior, token never leaks to stdout.

The Python-side contract tests live at
`backend/tests/test_recording_agent_service.py` and use a Python "fake
worker" that speaks the same JSON-line protocol — those don't depend on
this Node implementation.

## End-to-end verification

1. Provision a recording-agent FID + custody key, register via the
   Farcaster custody auth flow.
2. Configure env: `AWS_S3_BUCKET_NAME`, `AWS_DEFAULT_REGION`, optional
   `AWS_ENDPOINT_URL`, `JUKE_RECORDING_AGENT_FIDS`, etc.
3. Host a native room from Juke, hit `POST /v1/rooms/{id}/recording/start`.
4. Talk in the room for ~30 s.
5. `POST /v1/rooms/{id}/recording/stop`.
6. Verify the OGG file lands in S3 at the expected key and plays in
   QuickTime / VLC.

## Security notes

* The LiveKit JWT (`token` field) is bearer-equivalent for the agent
  FID's room scope. It must come from stdin, never argv (argv is
  world-readable via `/proc/<pid>/cmdline` on Linux). The Python side
  enforces this via `asyncio.create_subprocess_exec` with no argv
  beyond `node worker.mjs`.
* The worker never logs the token. All emitted JSON events are
  filtered through `emitEvent` which only writes known-safe fields.
* ffmpeg is invoked via `execve` with only static argv flags — no user
  input enters the argv vector, so there's no shell-injection surface.
* S3 credentials are picked up from the AWS SDK default chain. The
  worker never reads or echoes them.
