#!/usr/bin/env node
// Juke recording-agent worker — REAL implementation.
//
// Joins a Farcaster-native LiveKit room as a passive listener using
// the JWT supplied by the Python orchestrator, mixes every subscribed
// audio track via `@livekit/rtc-node`'s AudioMixer, feeds the mixed
// PCM into ffmpeg (encoding OGG/Opus), and streams ffmpeg's stdout
// straight into an S3 multipart upload.
//
// Wire protocol with `app/services/recording_agent_service.py`:
//
//   stdin  : one JSON object — { recording_id, signaling_url, token,
//            room_id, s3_target }. `s3_target` is the S3 object KEY
//            (e.g. `recordings/{room_id}/native-{ts}.ogg`); the bucket
//            / region / endpoint are read from the environment so the
//            Python side stays storage-agnostic.
//   stdout : JSON-line events:
//              {event: "started"}        — connected + ffmpeg spawned
//              {event: "progress", bytes}— periodic upload progress
//              {event: "finalized", url} — graceful stop, S3 URL ready
//              {event: "error", message} — fatal failure, exit non-zero
//
// SIGTERM = finalize gracefully → exit 0.
//
// SECURITY:
//   - The token is read from stdin and NEVER logged, echoed, or passed
//     as argv. argv is world-readable via /proc/<pid>/cmdline on Linux.
//   - ffmpeg is invoked via execve (no shell), no user input goes into
//     argv — only static flags + the PCM/MP4 format strings.
//   - S3 credentials come from the AWS SDK's default credential chain
//     (env / instance profile). We don't log them or surface them in
//     any JSON event.
//   - All errors funnel through emitError() which sanitizes to a
//     stable message string before exiting non-zero.

import { spawn } from 'node:child_process';
import { createReadStream, promises as fsp, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import process, { stdin, stdout, stderr } from 'node:process';
import { PassThrough } from 'node:stream';

// CRITICAL: silence @livekit/rtc-node's internal pino logger BEFORE we
// import the library. The lib writes structured log lines to stdout by
// default (level/msg/name fields, no `event` key) — they look like
// our protocol's JSON-line events but aren't, and Python's
// `_read_event` previously rejected the worker on the first one.
// Recognized levels: trace, debug, info, warn, error, fatal, silent.
// `silent` drops everything.
if (!process.env.LIVEKIT_LOG_LEVEL && !process.env.LK_LOG_LEVEL) {
  process.env.LIVEKIT_LOG_LEVEL = 'silent';
  process.env.LK_LOG_LEVEL = 'silent';
}

import {
  AudioMixer,
  AudioStream,
  Room,
  RoomEvent,
  TrackKind,
  dispose,
} from '@livekit/rtc-node';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';

// ---------------------------------------------------------------------
// Constants — keep these in sync with the egress fallback so cleanup +
// presigning helpers keep working.
// ---------------------------------------------------------------------

const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
// 20 ms blocks, matches Opus' native frame size — gives the mixer a
// clean cadence and keeps end-to-end latency tight.
const BLOCK_SAMPLES = (SAMPLE_RATE * 20) / 1000;

// S3 multipart upload chunk size. 5 MiB is the AWS minimum; anything
// smaller errors. For a 1-hour recording @ ~32 kbps Opus we end up
// with ~14 MB total, so 1–3 parts per file. Plenty of headroom for
// 6+ hour rooms.
const S3_PART_SIZE_BYTES = 5 * 1024 * 1024;
const S3_UPLOAD_CONCURRENCY = 4;

const PROGRESS_INTERVAL_MS = 10_000;

// How often the checkpointer flushes newly-encoded bytes to S3 as
// multipart parts. This is crash-insurance: if the worker is hard-killed
// (OOM, SIGKILL past the drain window, uncaught crash) the parts already
// uploaded survive as an incomplete multipart upload that recovery can
// complete. Granularity is bounded by the 5 MiB S3 minimum part size —
// at 32 kbps that's ~22 min of audio per part — so a crash loses at most
// the tail since the last full part. The graceful paths (host stop,
// reconciler, SIGTERM drain) still capture everything.
const CHECKPOINT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------
// JSON-line protocol helpers
// ---------------------------------------------------------------------

/** Emit one JSON event line on stdout. Never includes secret material. */
function emitEvent(event) {
  stdout.write(JSON.stringify(event) + '\n');
}

/**
 * Emit a final `error` event and exit non-zero. `message` is sanitized
 * — we deliberately do NOT include the stack trace or any object that
 * might have token-bearing fields in its enumerable properties.
 */
function emitError(message) {
  try {
    emitEvent({ event: 'error', message: String(message ?? 'unknown error') });
  } catch {
    /* stdout already broken — nothing useful to do */
  }
  process.exit(1);
}

/**
 * Read exactly one newline-terminated JSON object from stdin.
 *
 * Accumulates until the first `\n`, parses everything before it,
 * pauses stdin. Stray whitespace before/after the JSON object is
 * tolerated so the Python side can write `JSON\n` without worrying
 * about exact byte counts.
 */
export function readFirstStdinLine(input = stdin) {
  return new Promise((resolve, reject) => {
    let buf = '';
    input.setEncoding('utf8');

    const onData = (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx < 0) return;
      const line = buf.slice(0, idx).trim();
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      input.removeListener('end', onEnd);
      try {
        input.pause();
      } catch {
        /* pausing stdin is best-effort */
      }
      try {
        resolve(JSON.parse(line));
      } catch (err) {
        reject(err);
      }
    };

    const onError = (err) => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      reject(err);
    };

    const onEnd = () => {
      input.removeListener('data', onData);
      input.removeListener('error', onError);
      if (!buf) {
        reject(new Error('stdin closed before config received'));
      } else {
        // EOF without newline — be liberal and try to parse what we
        // have. Empty/whitespace-only input still fails JSON.parse.
        try {
          resolve(JSON.parse(buf.trim()));
        } catch (err) {
          reject(err);
        }
      }
    };

    input.on('data', onData);
    input.once('error', onError);
    input.once('end', onEnd);
  });
}

// ---------------------------------------------------------------------
// Pure mixing helper — exposed for unit tests.
// ---------------------------------------------------------------------

/**
 * Sum N Int16Arrays sample-by-sample with saturating clip to int16.
 *
 * Used as a fallback if `AudioMixer` is unavailable in tests and to
 * give us a pure, side-effect-free target for unit tests.
 *
 * @param {Int16Array[]} frames Per-participant PCM chunks. All must
 *   be the same length. Missing/empty entries are ignored.
 * @returns {Int16Array} A new Int16Array of length BLOCK_SAMPLES (or
 *   the input length when all frames are non-empty).
 */
export function mixFrames(frames) {
  const sized = frames.filter((f) => f && f.length > 0);
  if (sized.length === 0) {
    return new Int16Array(BLOCK_SAMPLES);
  }
  const len = sized[0].length;
  // Sanity: all inputs same length. Trim/zero-pad rather than throw —
  // the recording must keep going even if a stream hiccups.
  const out = new Int16Array(len);
  for (const f of sized) {
    const n = Math.min(len, f.length);
    for (let i = 0; i < n; i++) {
      const sum = out[i] + f[i];
      out[i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Trust-boundary validators — every field from stdin / upstream JSON
// gets sanity-checked here before it can drive a network call or
// reach S3 / ffmpeg.
// ---------------------------------------------------------------------

/**
 * Reject signaling URLs that aren't WebSocket schemes. Defense in depth:
 * the Python orchestrator gets `signaling_url` from the upstream
 * Farcaster `audio-room/join` response, which we trust — but a
 * compromised/spoofed upstream or a future protocol change must NOT
 * let us dial an attacker-controlled `http://` endpoint or worse a
 * `javascript:` URL into the LiveKit SDK's URL parser.
 */
export function validateSignalingUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) {
    throw new Error('signaling_url malformed');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('signaling_url is not a valid URL');
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error('signaling_url must use ws:// or wss://');
  }
  return raw;
}

/**
 * Reject S3 keys that don't sit under the canonical `recordings/`
 * prefix or that try to traverse out of it. Mirrors the same prefix
 * enforcement that `storage_service.extract_recording_s3_key` applies
 * on the read side — keeping both sides aligned means a malformed
 * call site can't trick us into writing to an arbitrary object.
 */
export function validateS3Key(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) {
    throw new Error('s3_target malformed');
  }
  if (!raw.startsWith('recordings/')) {
    throw new Error('s3_target must start with "recordings/"');
  }
  // Reject path-traversal segments and any control / NUL characters
  // that S3 will happily store but no downstream tool wants to handle.
  if (raw.includes('..') || /[\x00-\x1f]/.test(raw)) {
    throw new Error('s3_target contains illegal characters');
  }
  return raw;
}

// ---------------------------------------------------------------------
// S3 URL construction — matches the existing egress format so
// `extract_recording_s3_key` (storage_service.py) accepts the result.
// ---------------------------------------------------------------------

/**
 * Build the recording_url that gets persisted on `rooms.recording_url`.
 *
 * Two cases mirror the egress path:
 *   - Custom endpoint (Tigris, Cloudflare R2, etc.): path-style
 *     `{endpoint}/{bucket}/{key}`. extract_recording_s3_key matches
 *     by hostname == endpoint host and path startsWith `{bucket}/`.
 *   - No custom endpoint (real AWS): virtual-hosted-style
 *     `https://{bucket}.s3.{region}.amazonaws.com/{key}`.
 */
export function buildRecordingUrl({ bucket, region, endpoint, key }) {
  if (!bucket || !key) {
    throw new Error('buildRecordingUrl: bucket and key are required');
  }
  if (endpoint) {
    const trimmed = endpoint.replace(/\/+$/, '');
    return `${trimmed}/${bucket}/${key}`;
  }
  const r = region || 'us-east-1';
  return `https://${bucket}.s3.${r}.amazonaws.com/${key}`;
}

// ---------------------------------------------------------------------
// Incremental multipart checkpointing — crash insurance.
// ---------------------------------------------------------------------

/**
 * Plan which byte ranges of the temp file to upload as multipart parts.
 *
 * Pure + exported for unit tests. Given how many bytes we've already
 * consumed into parts (`uploadedOffset`) and the current file size,
 * return the `{start, end}` ranges to upload next.
 *
 *   - Non-final: only emit FULL `partSize` ranges. S3 requires every
 *     part except the last to be >= 5 MiB, so we never flush a short
 *     part mid-stream; the remainder waits for the next tick.
 *   - Final: emit everything left, splitting into `partSize` chunks with
 *     a (possibly short) last chunk — which S3 allows only as the final
 *     part.
 *
 * @returns {{start:number,end:number}[]}
 */
export function computePartPlan(uploadedOffset, fileSize, partSize, final) {
  const ranges = [];
  let off = uploadedOffset;
  if (fileSize - off <= 0) return ranges;
  if (final) {
    while (fileSize - off > 0) {
      ranges.push({ start: off, end: Math.min(off + partSize, fileSize) });
      off = Math.min(off + partSize, fileSize);
    }
  } else {
    while (fileSize - off >= partSize) {
      ranges.push({ start: off, end: off + partSize });
      off += partSize;
    }
  }
  return ranges;
}

/**
 * Drive an incremental, MANUAL S3 multipart upload off the growing temp
 * file. Deliberately NOT `@aws-sdk/lib-storage`'s `Upload` — that
 * abstraction emitted opaque errors when reconciling a streamed
 * finalization in production. Here we own every call (Create / UploadPart
 * / Complete / Abort) with explicit ETags, so behaviour is deterministic.
 *
 * Contract:
 *   - `tick()` — best-effort periodic flush of full parts. Swallows
 *     errors by disabling itself (the temp-file single-PutObject fallback
 *     still finalizes the recording cleanly).
 *   - `finalize(finalFileSize)` — returns `true` if it completed the
 *     multipart object (caller does nothing more), `false` if the caller
 *     should fall back to a single PutObject (small file, never started,
 *     or an error aborted the upload).
 *   - On hard crash neither runs; the parts already uploaded persist as
 *     an incomplete multipart upload that backend recovery completes.
 */
export function createMultipartCheckpointer({ s3, bucket, key, filePath, partSize, log }) {
  let uploadId = null;
  let nextPartNumber = 1;
  let uploadedOffset = 0;
  const parts = []; // { PartNumber, ETag }
  let disabled = false;
  let flushing = false;

  async function ensureStarted() {
    if (uploadId) return;
    const resp = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        ContentType: 'audio/ogg',
      }),
    );
    uploadId = resp.UploadId;
    if (!uploadId) throw new Error('CreateMultipartUpload returned no UploadId');
  }

  async function uploadRange({ start, end }) {
    const len = end - start;
    const fh = await fsp.open(filePath, 'r');
    try {
      const buf = Buffer.allocUnsafe(len);
      await fh.read(buf, 0, len, start);
      const partNumber = nextPartNumber++;
      const resp = await s3.send(
        new UploadPartCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: buf,
          ContentLength: len,
        }),
      );
      parts.push({ PartNumber: partNumber, ETag: resp.ETag });
      uploadedOffset = end;
    } finally {
      await fh.close();
    }
  }

  async function abort() {
    if (!uploadId) return;
    try {
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch {
      /* best-effort — an aborted-but-not-cleaned MPU is harmless; the
         bucket's incomplete-MPU lifecycle rule sweeps it eventually. */
    }
    uploadId = null;
  }

  return {
    isStarted: () => Boolean(uploadId),
    partsCount: () => parts.length,

    async tick(fileSize) {
      if (disabled || flushing) return;
      flushing = true;
      try {
        const plan = computePartPlan(uploadedOffset, fileSize, partSize, false);
        if (plan.length === 0) return;
        await ensureStarted();
        for (const range of plan) {
          await uploadRange(range);
        }
      } catch (err) {
        // Crash-insurance must never break the recording. Disable +
        // abort; the temp-file single-PutObject path still finalizes.
        disabled = true;
        if (log) log(`checkpoint flush failed, falling back: ${err?.name ?? 'Error'}`);
        await abort();
      } finally {
        flushing = false;
      }
    },

    async finalize(finalFileSize) {
      if (disabled) return false;
      try {
        const plan = computePartPlan(
          uploadedOffset,
          finalFileSize,
          partSize,
          true,
        );
        // Never started AND the whole file fits in one (short) part →
        // let the caller PutObject it. Keeps the proven path for the
        // common small-recording case untouched.
        if (!uploadId && plan.length <= 1) return false;
        await ensureStarted();
        for (const range of plan) {
          await uploadRange(range);
        }
        if (parts.length === 0) return false;
        await s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts },
          }),
        );
        uploadId = null; // completed — nothing to abort
        return true;
      } catch (err) {
        if (log) log(`multipart finalize failed, falling back: ${err?.name ?? 'Error'}`);
        await abort();
        return false;
      }
    },

    abort,
  };
}

// ---------------------------------------------------------------------
// Main recording loop
// ---------------------------------------------------------------------

/**
 * Spawn ffmpeg configured to consume raw 48 kHz mono s16le PCM from
 * stdin and emit OGG/Opus directly to a local file path. We use a
 * temp file (not stdout) so the S3 upload happens AFTER ffmpeg has
 * exited and the file is fully written — `@aws-sdk/lib-storage`
 * Upload backed by a child-process stdout stream proved fragile in
 * production (lib-storage emits `Error` with no detail when the
 * stream-to-multipart finalization can't reconcile, regardless of
 * whether the bytes were valid). A file-based upload matches what
 * the working egress path does (LiveKit writes to disk then PUTs the
 * file with a known Content-Length).
 *
 * Errors funnel through `onError`.
 */
function spawnFfmpeg(onError, outputPath) {
  const ff = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel', 'warning',
      // Input: raw PCM from our mixer pipe.
      '-f', 's16le',
      '-ar', String(SAMPLE_RATE),
      '-ac', String(CHANNELS),
      '-i', 'pipe:0',
      // Output: OGG/Opus to a local file. 32 kbps mono is plenty for
      // voice and matches what existing egress produces. `-y` lets us
      // overwrite if the path collides (it won't — recording_id is in
      // the path).
      '-y',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-vbr', 'on',
      '-application', 'voip',
      '-f', 'ogg',
      outputPath,
    ],
    { stdio: ['pipe', 'ignore', 'inherit'] },
  );

  ff.on('error', (err) => onError(`ffmpeg spawn failed: ${err.message}`));
  ff.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      // Non-zero exit is only fatal if we haven't already finalized.
      // We pass it through the shared error path; the shutdown
      // routine no-ops if it was already torn down.
      onError(`ffmpeg exited with code ${code} (signal ${signal})`);
    }
  });

  return ff;
}

async function main() {
  // -------- 1. Read config --------
  let config;
  try {
    config = await readFirstStdinLine();
  } catch (err) {
    // JSON.parse error messages include a snippet of the offending
    // input; that input contains the LiveKit token. Sanitize: emit
    // the error class only, send the detail to stderr.
    stderr.write(`[recording-agent] failed to read config: ${err?.name ?? 'Error'}\n`);
    emitError('failed to read config');
    return;
  }

  for (const field of ['recording_id', 'signaling_url', 'token', 's3_target']) {
    if (typeof config[field] !== 'string' || !config[field]) {
      emitError(`missing or invalid field: ${field}`);
      return;
    }
  }

  // Validate trust-boundary fields BEFORE wiring up any subprocess /
  // network / S3 state. Cheap to surface here as a single `error`
  // event rather than a half-spawned ffmpeg later.
  try {
    validateSignalingUrl(config.signaling_url);
    validateS3Key(config.s3_target);
  } catch (err) {
    emitError(err.message);
    return;
  }

  // S3 configuration comes from the environment, NOT the JSON payload,
  // so the Python side stays storage-agnostic.
  const bucket = process.env.AWS_S3_BUCKET_NAME;
  const region = process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION;
  const endpoint = process.env.AWS_ENDPOINT_URL || undefined;

  if (!bucket) {
    emitError('AWS_S3_BUCKET_NAME not set in environment');
    return;
  }
  if (!region) {
    emitError('AWS_DEFAULT_REGION not set in environment');
    return;
  }

  // -------- 2. Wire up ffmpeg + S3 upload --------

  // We control mixed PCM into ffmpeg via a PassThrough so the mixer
  // task and the encoder live in separate backpressure domains.
  const mixedPcm = new PassThrough({ highWaterMark: 64 * 1024 });

  let teardownStarted = false;
  const fatalErrors = [];
  // Hoisted to outer scope so `shutdown` can reference it even when an
  // error fires BEFORE the progress ticker is wired up (e.g. LiveKit
  // connect failure). Was a TDZ bug — early errors caused `shutdown` to
  // throw `ReferenceError: Cannot access 'progressTimer' before
  // initialization`, which masked the actual upstream failure reason
  // because the worker died before emitting an `error` event.
  let progressTimer = null;

  const onError = (msg) => {
    if (teardownStarted) return;
    fatalErrors.push(msg);
    // Don't exit synchronously — let shutdown() flush ffmpeg + S3 so
    // we never leak a half-finished multipart upload. shutdown()
    // surfaces the captured fatalErrors as an `error` event if any.
    shutdown('error').catch((err) => {
      // shutdown itself crashed (e.g. TDZ on a state machine that
      // wasn't fully initialised yet). Emit a structured error event
      // FIRST so the Python orchestrator has something useful to log
      // — without this the worker dies silently and the orchestrator
      // falls back to a generic "worker rejected start" with no
      // context. Then dump to stderr as a belt-and-suspenders signal.
      try {
        emitEvent({
          event: 'error',
          message: `${msg} (shutdown crashed: ${err?.message ?? err})`,
        });
      } catch {
        /* stdout already closed; nothing we can do */
      }
      stderr.write(`shutdown crashed: ${err?.stack ?? err}\n`);
      process.exit(1);
    });
  };

  // Ephemeral encoded-OGG file. ffmpeg writes here; we upload it in
  // a single PutObject after ffmpeg exits cleanly. Lives under
  // `/tmp/juke-recordings/` so a host that runs many concurrent
  // workers doesn't collide. Cleaned up in the finally branch of
  // shutdown — leak is bounded by the container's tmpfs.
  const tempRecordingDir = joinPath(tmpdir(), 'juke-recordings');
  await fsp.mkdir(tempRecordingDir, { recursive: true });
  const tempRecordingPath = joinPath(
    tempRecordingDir,
    `${config.recording_id}.ogg`,
  );

  const ffmpeg = spawnFfmpeg(onError, tempRecordingPath);
  mixedPcm.pipe(ffmpeg.stdin);

  const s3 = new S3Client({
    region,
    endpoint,
    // For S3-compatible providers (Tigris, R2, MinIO) we must force
    // path-style addressing so the bucket goes in the path, not the
    // subdomain. Mirrors `force_path_style=True` on the Python side.
    forcePathStyle: Boolean(endpoint),
  });

  // Bytes counter — reflects the encoded file size at finalize.
  let uploadedBytes = 0;

  // Incremental multipart checkpointer — crash insurance. Periodically
  // flushes full encoded parts to S3 so a hard kill leaves a recoverable
  // (completable) multipart upload instead of nothing. The temp file
  // remains the source of truth; this never blocks the recording.
  const checkpointer = createMultipartCheckpointer({
    s3,
    bucket,
    key: config.s3_target,
    filePath: tempRecordingPath,
    partSize: S3_PART_SIZE_BYTES,
    log: (m) => stderr.write(`[recording-agent] ${m}\n`),
  });
  let checkpointTimer = null;

  // -------- 3. Join the LiveKit room --------

  const room = new Room();
  try {
    await room.connect(config.signaling_url, config.token, {
      autoSubscribe: true,
      dynacast: false,
    });
  } catch (err) {
    // Don't surface `err.message` to stdout — LiveKit's ConnectError
    // and the underlying FFI binding occasionally embed the join URL
    // (which contains query-string credentials on some routes) into
    // the message text. Operators can correlate against stderr.
    stderr.write(
      `[recording-agent] livekit connect failed: ${err?.name ?? 'Error'}\n`,
    );
    onError('livekit connect failed');
    return;
  }

  // -------- 4. Mix per-participant audio streams --------

  const mixer = new AudioMixer(SAMPLE_RATE, CHANNELS, {
    blocksize: BLOCK_SAMPLES,
  });

  // Each participant's RemoteAudioTrack gets its own AudioStream that
  // feeds the mixer. Track them so we can stop on TrackUnsubscribed.
  const trackStreams = new Map(); // trackSid -> AudioStream

  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    const trackSid = track.sid;
    if (!trackSid) return;
    if (trackStreams.has(trackSid)) return; // duplicate event guard
    try {
      const stream = new AudioStream(track, {
        sampleRate: SAMPLE_RATE,
        numChannels: CHANNELS,
        frameSizeMs: 20,
      });
      mixer.addStream(stream);
      trackStreams.set(trackSid, stream);
      stderr.write(
        `[recording-agent] subscribed audio track ${trackSid} from ${participant.identity}\n`,
      );
    } catch (err) {
      stderr.write(
        `[recording-agent] failed to subscribe audio for ${participant.identity}: ${err?.message}\n`,
      );
    }
  });

  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    const trackSid = track.sid;
    if (!trackSid) return;
    const stream = trackStreams.get(trackSid);
    if (!stream) return;
    try {
      mixer.removeStream(stream);
    } catch {
      /* mixer may already be tearing down */
    }
    trackStreams.delete(trackSid);
  });

  room.on(RoomEvent.Disconnected, () => {
    // Upstream room went away (host left, server killed it, network
    // dropped past the SDK's reconnect budget). Treat as a graceful
    // finalize signal — we want whatever audio we have.
    if (!teardownStarted) {
      shutdown('disconnect').catch((err) => {
        stderr.write(`shutdown on disconnect crashed: ${err?.stack ?? err}\n`);
        process.exit(1);
      });
    }
  });

  // Pump mixed frames into ffmpeg's stdin pipe.
  const pumpDone = (async () => {
    try {
      for await (const frame of mixer) {
        // frame.data is an Int16Array view into FFI memory; copy into
        // a Buffer that owns its own storage before piping.
        const buf = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
        // Drain backpressure cooperatively. PassThrough.write returns
        // false when its buffer is full; await 'drain' before pushing
        // more so ffmpeg gets a chance to consume.
        if (!mixedPcm.write(Buffer.from(buf))) {
          await new Promise((resolve) => mixedPcm.once('drain', resolve));
        }
      }
    } catch (err) {
      stderr.write(
        `[recording-agent] mixer pump failed: ${err?.name ?? 'Error'}\n`,
      );
      onError('mixer pump failed');
    }
  })();

  // -------- 5. Started event + progress ticker --------

  emitEvent({ event: 'started' });

  progressTimer = setInterval(() => {
    emitEvent({ event: 'progress', bytes: uploadedBytes });
  }, PROGRESS_INTERVAL_MS);
  // Don't keep the event loop alive just for progress logs.
  progressTimer.unref();

  // Periodically flush full encoded parts to S3 (crash insurance).
  // Best-effort: the checkpointer disables itself on any error so a
  // flaky upload can never disrupt the recording itself.
  checkpointTimer = setInterval(() => {
    let size = 0;
    try {
      size = statSync(tempRecordingPath).size;
    } catch {
      return; // file not created yet / transient — try again next tick
    }
    void checkpointer.tick(size);
  }, CHECKPOINT_INTERVAL_MS);
  checkpointTimer.unref();

  // -------- 6. Graceful shutdown --------

  async function shutdown(reason) {
    if (teardownStarted) return;
    teardownStarted = true;
    // Null-safe: an error that fires before the progress ticker was
    // wired up still calls shutdown, and `clearInterval(null)` is a
    // no-op per spec.
    if (progressTimer) clearInterval(progressTimer);
    if (checkpointTimer) clearInterval(checkpointTimer);

    // 1. Stop pulling from the room.
    try {
      await room.disconnect();
    } catch {
      /* best-effort */
    }

    // 2. Drain the mixer so any buffered frames flush before we close
    //    the PCM pipe. endInput() lets the mixer iterator complete on
    //    its own; pumpDone resolves when it does.
    try {
      mixer.endInput();
    } catch {
      /* mixer may already be closed */
    }
    try {
      await Promise.race([
        pumpDone,
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    } catch {
      /* swallow — pump errors already routed through onError */
    }

    // 3. Close the PCM pipe so ffmpeg sees EOF on stdin and flushes
    //    its final Opus frames.
    try {
      mixedPcm.end();
    } catch {
      /* already ended */
    }

    // 4. Wait for ffmpeg to exit. With file output, exit means the
    //    full encoded OGG is on disk with valid headers + EOS pages —
    //    no streaming finalization race like the previous Upload
    //    approach.
    await new Promise((resolve) => {
      if (ffmpeg.exitCode !== null) return resolve();
      ffmpeg.once('exit', () => resolve());
      // Safety net — give ffmpeg 15s to drain before we kill it.
      setTimeout(() => {
        if (ffmpeg.exitCode === null) {
          try {
            ffmpeg.kill('SIGKILL');
          } catch {
            /* already dead */
          }
        }
        resolve();
      }, 15_000).unref();
    });

    // 5. Persist the encoded file to S3. Prefer COMPLETING the
    //    incremental multipart upload (only the final remainder needs
    //    sending — cheap, and important inside the bounded SIGTERM drain
    //    window). If multipart was never started (small file) or errored,
    //    fall back to a single PutObject of the whole file — the proven,
    //    deterministic path. The temp file is always the source of truth,
    //    so the fallback yields byte-identical output. All AWS error
    //    fields go to stderr (operator-only, no credentials in v3 error
    //    bodies); the stdout `error` event stays sanitized.
    if (fatalErrors.length === 0) {
      try {
        const stats = statSync(tempRecordingPath);
        uploadedBytes = stats.size;
        if (stats.size === 0) {
          throw new Error('encoded file is empty');
        }
        const completed = await checkpointer.finalize(stats.size);
        if (!completed) {
          // Multipart not used / fell back — make sure no orphaned MPU
          // lingers, then PUT the whole file.
          await checkpointer.abort();
          const body = createReadStream(tempRecordingPath);
          await s3.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: config.s3_target,
              Body: body,
              ContentLength: stats.size,
              ContentType: 'audio/ogg',
            }),
          );
        }
      } catch (err) {
        const status = err?.$metadata?.httpStatusCode;
        const code = err?.Code || err?.code;
        stderr.write(
          `[recording-agent] s3 upload error: ` +
            `name=${err?.name ?? 'Error'} ` +
            `code=${code ?? '?'} ` +
            `status=${status ?? '?'} ` +
            `bucket=${bucket} key=${config.s3_target} ` +
            `endpoint=${endpoint ?? '<default>'} ` +
            `region=${region} ` +
            `message=${err?.message ?? String(err)}\n`,
        );
        fatalErrors.push(
          `s3 upload failed: ${code ?? err?.name ?? 'Error'}`,
        );
      }
    } else {
      // Recording is being torn down due to an earlier fatal error — no
      // clean object will be written, so don't leave a partial multipart
      // upload lingering on the key.
      await checkpointer.abort();
    }

    // 6. Best-effort temp file cleanup. We're about to exit anyway,
    //    but leaving stale files in /tmp adds up across many
    //    recordings on a long-lived container.
    try {
      await fsp.unlink(tempRecordingPath);
    } catch {
      /* file may not exist if ffmpeg never created it */
    }

    // 7. Dispose of LiveKit FFI resources.
    try {
      await dispose();
    } catch {
      /* best-effort */
    }

    // 8. Emit final event.
    if (fatalErrors.length > 0) {
      emitEvent({ event: 'error', message: fatalErrors[0] });
      process.exit(1);
    }

    const url = buildRecordingUrl({
      bucket,
      region,
      endpoint,
      key: config.s3_target,
    });
    emitEvent({ event: 'finalized', url, bytes: uploadedBytes });
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => {
      stderr.write(`shutdown crashed: ${err?.stack ?? err}\n`);
      process.exit(1);
    });
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => {
      stderr.write(`shutdown crashed: ${err?.stack ?? err}\n`);
      process.exit(1);
    });
  });
}

process.on('uncaughtException', (err) => {
  // Route the detail to stderr (operator-only) and surface only the
  // error class on stdout. Some upstream SDK errors carry URL / token
  // fragments in `err.message`, and stdout is the protocol channel
  // the Python orchestrator reads.
  stderr.write(`[recording-agent] uncaughtException: ${err?.stack ?? err}\n`);
  emitError(`uncaught exception: ${err?.name ?? 'Error'}`);
});
process.on('unhandledRejection', (reason) => {
  stderr.write(`[recording-agent] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}\n`);
  emitError(
    `unhandled rejection: ${reason instanceof Error ? reason.name : 'Error'}`,
  );
});

// Only run main() when invoked as the entrypoint — keeps the file
// importable by the unit-test module.
const isEntrypoint =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('worker.mjs');

if (isEntrypoint) {
  main().catch((err) => {
    emitError(err?.message ?? String(err));
  });
}
