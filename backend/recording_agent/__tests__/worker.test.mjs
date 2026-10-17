// Unit tests for the recording-agent worker.
//
// We don't try to mock @livekit/rtc-node or @aws-sdk/lib-storage — those
// are integration boundaries that need a real room / real S3 to be
// meaningful. What we DO cover:
//
//   1. mixFrames() — pure PCM summation + saturating clip.
//   2. readFirstStdinLine() — exactly one line, tolerant of stray
//      whitespace.
//   3. buildRecordingUrl() — output format matches what
//      `storage_service.extract_recording_s3_key` accepts for both
//      Tigris-style custom endpoints and bare AWS.
//   4. CLI invocation: when stdin is missing required fields the worker
//      emits a single `error` JSON line and exits non-zero (smoke-tests
//      the wire protocol the Python orchestrator relies on).

import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildRecordingUrl,
  computePartPlan,
  mixFrames,
  readFirstStdinLine,
  validateS3Key,
  validateSignalingUrl,
} from '../worker.mjs';

const MiB = 1024 * 1024;
const PART = 5 * MiB;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.resolve(HERE, '..', 'worker.mjs');

// ---------------------------------------------------------------------
// computePartPlan — multipart checkpoint planning
// ---------------------------------------------------------------------

test('computePartPlan: non-final emits only full 5MiB parts', () => {
  // 12 MiB available -> two full 5MiB parts, 2MiB remainder held back.
  const plan = computePartPlan(0, 12 * MiB, PART, false);
  assert.deepEqual(plan, [
    { start: 0, end: PART },
    { start: PART, end: 2 * PART },
  ]);
});

test('computePartPlan: non-final holds back a sub-part remainder', () => {
  // 4 MiB available, under the 5MiB minimum -> nothing flushed yet.
  assert.deepEqual(computePartPlan(0, 4 * MiB, PART, false), []);
});

test('computePartPlan: non-final respects already-uploaded offset', () => {
  // 5MiB already consumed, file now 11MiB -> one more full part.
  assert.deepEqual(computePartPlan(PART, 11 * MiB, PART, false), [
    { start: PART, end: 2 * PART },
  ]);
});

test('computePartPlan: final flushes the short trailing remainder', () => {
  // 5MiB consumed, file 7MiB -> final 2MiB part (allowed as last part).
  assert.deepEqual(computePartPlan(PART, 7 * MiB, PART, true), [
    { start: PART, end: 7 * MiB },
  ]);
});

test('computePartPlan: final splits everything left into 5MiB + tail', () => {
  // Nothing uploaded, file 12MiB -> [5,5,2].
  assert.deepEqual(computePartPlan(0, 12 * MiB, PART, true), [
    { start: 0, end: PART },
    { start: PART, end: 2 * PART },
    { start: 2 * PART, end: 12 * MiB },
  ]);
});

test('computePartPlan: nothing new to upload returns empty', () => {
  assert.deepEqual(computePartPlan(7 * MiB, 7 * MiB, PART, true), []);
  assert.deepEqual(computePartPlan(7 * MiB, 7 * MiB, PART, false), []);
});

test('computePartPlan: small final file is a single short part', () => {
  // 3MiB total, never started -> one short part (caller treats <=1 part
  // as "fall back to single PutObject").
  assert.deepEqual(computePartPlan(0, 3 * MiB, PART, true), [
    { start: 0, end: 3 * MiB },
  ]);
});

// ---------------------------------------------------------------------
// mixFrames
// ---------------------------------------------------------------------

test('mixFrames: empty input returns zero-filled block', () => {
  const out = mixFrames([]);
  assert.equal(out.constructor.name, 'Int16Array');
  assert.ok(out.length > 0);
  for (const s of out) assert.equal(s, 0);
});

test('mixFrames: single frame passes through unchanged', () => {
  const a = new Int16Array([100, -200, 300, -400]);
  const out = mixFrames([a]);
  assert.deepEqual(Array.from(out), [100, -200, 300, -400]);
});

test('mixFrames: sums multiple frames sample-by-sample', () => {
  const a = new Int16Array([100, 200, 300]);
  const b = new Int16Array([10, 20, 30]);
  const c = new Int16Array([1, 2, 3]);
  const out = mixFrames([a, b, c]);
  assert.deepEqual(Array.from(out), [111, 222, 333]);
});

test('mixFrames: clips positive overflow to int16 max', () => {
  const a = new Int16Array([30_000, 30_000]);
  const b = new Int16Array([10_000, 10_000]);
  const out = mixFrames([a, b]);
  assert.deepEqual(Array.from(out), [32_767, 32_767]);
});

test('mixFrames: clips negative overflow to int16 min', () => {
  const a = new Int16Array([-30_000, -30_000]);
  const b = new Int16Array([-10_000, -10_000]);
  const out = mixFrames([a, b]);
  assert.deepEqual(Array.from(out), [-32_768, -32_768]);
});

test('mixFrames: ignores empty/missing entries', () => {
  const a = new Int16Array([10, 20]);
  const empty = new Int16Array(0);
  const out = mixFrames([a, empty, null, undefined]);
  assert.deepEqual(Array.from(out), [10, 20]);
});

test('mixFrames: tolerates length mismatch by trimming to first length', () => {
  const a = new Int16Array([10, 20, 30, 40]);
  const b = new Int16Array([1, 2]);
  const out = mixFrames([a, b]);
  // b only contributes the first two samples.
  assert.deepEqual(Array.from(out), [11, 22, 30, 40]);
});

// ---------------------------------------------------------------------
// readFirstStdinLine
// ---------------------------------------------------------------------

function fakeStdin(text) {
  // A Readable in objectMode=false that yields the text then ends. We
  // need setEncoding to be a no-op fn since the worker calls it.
  const stream = Readable.from([text]);
  // Readable.from streams don't implement setEncoding; stub it.
  stream.setEncoding = () => {};
  return stream;
}

test('readFirstStdinLine: parses a single JSON line', async () => {
  const config = { recording_id: 'r', signaling_url: 'wss://x', token: 't', s3_target: 'k' };
  const stream = fakeStdin(JSON.stringify(config) + '\n');
  const parsed = await readFirstStdinLine(stream);
  assert.deepEqual(parsed, config);
});

test('readFirstStdinLine: tolerates trailing whitespace before newline', async () => {
  const config = { a: 1 };
  const stream = fakeStdin(JSON.stringify(config) + '   \n');
  const parsed = await readFirstStdinLine(stream);
  assert.deepEqual(parsed, config);
});

test('readFirstStdinLine: rejects malformed JSON', async () => {
  const stream = fakeStdin('not json\n');
  await assert.rejects(() => readFirstStdinLine(stream), /JSON/i);
});

test('readFirstStdinLine: rejects when stdin closes empty', async () => {
  const stream = Readable.from(['']);
  stream.setEncoding = () => {};
  await assert.rejects(
    () => readFirstStdinLine(stream),
    /stdin closed before config received/,
  );
});

test('readFirstStdinLine: parses JSON even without trailing newline', async () => {
  const config = { a: 1, b: 'two' };
  // No trailing \n — EOF fallback should still parse.
  const stream = fakeStdin(JSON.stringify(config));
  const parsed = await readFirstStdinLine(stream);
  assert.deepEqual(parsed, config);
});

// ---------------------------------------------------------------------
// buildRecordingUrl
// ---------------------------------------------------------------------

test('buildRecordingUrl: custom endpoint uses path-style', () => {
  const url = buildRecordingUrl({
    bucket: 'juke-recordings',
    region: 'auto',
    endpoint: 'https://fly.storage.tigris.dev',
    key: 'recordings/abc/native.ogg',
  });
  assert.equal(url, 'https://fly.storage.tigris.dev/juke-recordings/recordings/abc/native.ogg');
});

test('buildRecordingUrl: strips trailing slash from endpoint', () => {
  const url = buildRecordingUrl({
    bucket: 'b',
    region: 'r',
    endpoint: 'https://example.com/',
    key: 'recordings/k.ogg',
  });
  assert.equal(url, 'https://example.com/b/recordings/k.ogg');
});

test('buildRecordingUrl: bare AWS uses virtual-hosted-style', () => {
  const url = buildRecordingUrl({
    bucket: 'juke-recordings',
    region: 'us-west-2',
    endpoint: undefined,
    key: 'recordings/abc/native.ogg',
  });
  assert.equal(
    url,
    'https://juke-recordings.s3.us-west-2.amazonaws.com/recordings/abc/native.ogg',
  );
});

test('buildRecordingUrl: defaults to us-east-1 when region missing', () => {
  const url = buildRecordingUrl({
    bucket: 'b',
    region: undefined,
    endpoint: undefined,
    key: 'recordings/k.ogg',
  });
  assert.equal(url, 'https://b.s3.us-east-1.amazonaws.com/recordings/k.ogg');
});

test('buildRecordingUrl: requires bucket and key', () => {
  assert.throws(() => buildRecordingUrl({ bucket: '', key: 'k' }));
  assert.throws(() => buildRecordingUrl({ bucket: 'b', key: '' }));
});

// ---------------------------------------------------------------------
// validateSignalingUrl
// ---------------------------------------------------------------------

test('validateSignalingUrl: accepts wss://', () => {
  assert.equal(
    validateSignalingUrl('wss://livekit.farcaster.xyz/rtc'),
    'wss://livekit.farcaster.xyz/rtc',
  );
});

test('validateSignalingUrl: accepts ws:// for dev', () => {
  assert.equal(
    validateSignalingUrl('ws://localhost:7880'),
    'ws://localhost:7880',
  );
});

test('validateSignalingUrl: rejects http://', () => {
  assert.throws(() => validateSignalingUrl('http://example.com'), /ws:\/\/ or wss:\/\//);
});

test('validateSignalingUrl: rejects javascript:', () => {
  assert.throws(() => validateSignalingUrl('javascript:alert(1)'));
});

test('validateSignalingUrl: rejects garbage', () => {
  assert.throws(() => validateSignalingUrl('not a url'));
  assert.throws(() => validateSignalingUrl(''));
  assert.throws(() => validateSignalingUrl(null));
  assert.throws(() => validateSignalingUrl(undefined));
});

test('validateSignalingUrl: rejects suspiciously long URLs', () => {
  const url = 'wss://example.com/' + 'a'.repeat(3000);
  assert.throws(() => validateSignalingUrl(url));
});

// ---------------------------------------------------------------------
// validateS3Key
// ---------------------------------------------------------------------

test('validateS3Key: accepts recordings/-prefixed keys', () => {
  assert.equal(
    validateS3Key('recordings/abc/native-123.ogg'),
    'recordings/abc/native-123.ogg',
  );
});

test('validateS3Key: rejects keys outside recordings/', () => {
  assert.throws(() => validateS3Key('secrets/key.txt'), /recordings\//);
  assert.throws(() => validateS3Key('/etc/passwd'));
  assert.throws(() => validateS3Key(''));
});

test('validateS3Key: rejects path traversal', () => {
  assert.throws(() => validateS3Key('recordings/../secrets/k.ogg'), /illegal/);
  assert.throws(() => validateS3Key('recordings/abc/../foo.ogg'), /illegal/);
});

test('validateS3Key: rejects control characters and NUL', () => {
  assert.throws(() => validateS3Key('recordings/abc\0.ogg'), /illegal/);
  assert.throws(() => validateS3Key('recordings/abc\n.ogg'), /illegal/);
});

// ---------------------------------------------------------------------
// CLI invocation — wire protocol smoke
// ---------------------------------------------------------------------

/**
 * Spawn the worker as a subprocess, feed it `stdinPayload`, and collect
 * stdout. Returns { code, lines }.
 */
function runWorker(stdinPayload, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    let stdoutBuf = '';
    let stderrBuf = '';
    proc.stdout.on('data', (chunk) => (stdoutBuf += chunk.toString('utf8')));
    proc.stderr.on('data', (chunk) => (stderrBuf += chunk.toString('utf8')));
    proc.on('error', reject);
    proc.on('exit', (code) => {
      const lines = stdoutBuf
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        });
      resolve({ code, lines, stderr: stderrBuf });
    });
    proc.stdin.write(stdinPayload);
    proc.stdin.end();
  });
}

test('worker CLI: missing recording_id emits error and exits non-zero', async () => {
  const payload =
    JSON.stringify({
      signaling_url: 'wss://x',
      token: 't',
      s3_target: 'k',
    }) + '\n';
  const { code, lines } = await runWorker(payload, {
    AWS_S3_BUCKET_NAME: 'test',
    AWS_DEFAULT_REGION: 'us-east-1',
  });
  assert.notEqual(code, 0);
  const last = lines[lines.length - 1];
  assert.equal(last.event, 'error');
  assert.match(last.message, /recording_id/);
});

test('worker CLI: malformed JSON on stdin emits error and exits non-zero', async () => {
  const { code, lines } = await runWorker('not json\n', {
    AWS_S3_BUCKET_NAME: 'test',
    AWS_DEFAULT_REGION: 'us-east-1',
  });
  assert.notEqual(code, 0);
  const last = lines[lines.length - 1];
  assert.equal(last.event, 'error');
  assert.match(last.message, /failed to read config/i);
});

test('worker CLI: missing AWS_S3_BUCKET_NAME emits error', async () => {
  const payload =
    JSON.stringify({
      recording_id: 'r',
      signaling_url: 'wss://x',
      token: 't',
      s3_target: 'recordings/r.ogg',
    }) + '\n';
  // Strip the var explicitly. Some shells preset it.
  const env = { ...process.env, AWS_DEFAULT_REGION: 'us-east-1' };
  delete env.AWS_S3_BUCKET_NAME;
  const { code, lines } = await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    let stdoutBuf = '';
    proc.stdout.on('data', (chunk) => (stdoutBuf += chunk.toString('utf8')));
    proc.on('error', reject);
    proc.on('exit', (c) => {
      const ls = stdoutBuf
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { raw: l };
          }
        });
      resolve({ code: c, lines: ls });
    });
    proc.stdin.write(payload);
    proc.stdin.end();
  });
  assert.notEqual(code, 0);
  const last = lines[lines.length - 1];
  assert.equal(last.event, 'error');
  assert.match(last.message, /AWS_S3_BUCKET_NAME/);
});

test('worker CLI: rejects non-ws signaling_url', async () => {
  const payload =
    JSON.stringify({
      recording_id: 'r',
      signaling_url: 'http://attacker.example',
      token: 't',
      s3_target: 'recordings/r.ogg',
    }) + '\n';
  const { code, lines } = await runWorker(payload, {
    AWS_S3_BUCKET_NAME: 'test',
    AWS_DEFAULT_REGION: 'us-east-1',
  });
  assert.notEqual(code, 0);
  const last = lines[lines.length - 1];
  assert.equal(last.event, 'error');
  assert.match(last.message, /ws:\/\/ or wss:\/\//);
});

test('worker CLI: rejects s3_target outside recordings/ prefix', async () => {
  const payload =
    JSON.stringify({
      recording_id: 'r',
      signaling_url: 'wss://x',
      token: 't',
      s3_target: 'secrets/k.ogg',
    }) + '\n';
  const { code, lines } = await runWorker(payload, {
    AWS_S3_BUCKET_NAME: 'test',
    AWS_DEFAULT_REGION: 'us-east-1',
  });
  assert.notEqual(code, 0);
  const last = lines[lines.length - 1];
  assert.equal(last.event, 'error');
  assert.match(last.message, /recordings\//);
});

test('worker CLI: rejects path-traversal s3_target', async () => {
  const payload =
    JSON.stringify({
      recording_id: 'r',
      signaling_url: 'wss://x',
      token: 't',
      s3_target: 'recordings/../../etc/passwd',
    }) + '\n';
  const { code, lines } = await runWorker(payload, {
    AWS_S3_BUCKET_NAME: 'test',
    AWS_DEFAULT_REGION: 'us-east-1',
  });
  assert.notEqual(code, 0);
  const last = lines[lines.length - 1];
  assert.equal(last.event, 'error');
  assert.match(last.message, /illegal|recordings/);
});

test('worker CLI: malformed JSON path does not leak token to stdout', async () => {
  // Use a payload that LOOKS like JSON containing the token but is
  // malformed so JSON.parse throws — historically Node's error message
  // includes a snippet of the input, which would leak the token.
  const TOKEN = 'TOKEN_TO_NOT_LEAK_IN_JSON_ERR';
  const malformed = `{"token":"${TOKEN}",this_is_not_valid_json}\n`;
  const { lines, stderr } = await runWorker(malformed, {
    AWS_S3_BUCKET_NAME: 'test',
    AWS_DEFAULT_REGION: 'us-east-1',
  });
  const stdoutJson = JSON.stringify(lines);
  assert.equal(
    stdoutJson.includes(TOKEN),
    false,
    `token leaked to stdout: ${stdoutJson}`,
  );
  // stderr is operator-only; we don't enforce that the token isn't
  // there (some debug paths can include it), but the protocol stdout
  // must stay clean.
  void stderr;
});

test('worker CLI: never echoes the token back to stdout', async () => {
  const TOKEN = 'SUPER_SECRET_LIVEKIT_JWT_DO_NOT_LEAK';
  const payload =
    JSON.stringify({
      // Missing recording_id intentionally — fails validation before
      // we ever attempt to connect; the test just asserts that no
      // path along the validation chain re-emits the token.
      signaling_url: 'wss://x',
      token: TOKEN,
      s3_target: 'recordings/r.ogg',
    }) + '\n';
  const { lines, stderr } = await runWorker(payload, {
    AWS_S3_BUCKET_NAME: 'test',
    AWS_DEFAULT_REGION: 'us-east-1',
  });
  const raw = JSON.stringify(lines) + '\n' + stderr;
  assert.equal(raw.includes(TOKEN), false, 'token must never be echoed');
});
