/**
 * Snap signer — on-device Ed25519 keypair for Farcaster Snap interactivity.
 *
 * Farcaster Snap servers strictly require JFS bodies signed with an `app_key`
 * (Ed25519) registered on the hub for the user's fid. Auth addresses
 * (secp256k1) are rejected.
 *
 * We generate the keypair on device (stored in SecureStore), register the
 * public key via our backend + Neynar's developer-managed signer API, and
 * sign snap POST bodies locally using @noble/ed25519.
 */

import '@/utils/cryptoPolyfill';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import * as api from '@/services/api';

// Wire the hash implementation — required by @noble/ed25519 v3.
ed.hashes.sha512 = sha512;

const SNAP_KEY_PREFIX = 'snap_signer_key_';
const SNAP_STATUS_PREFIX = 'snap_signer_status_';

/**
 * Keychain accessibility for all snap-signer items. `_THIS_DEVICE_ONLY`
 * prevents iCloud Keychain / encrypted-backup migration, so compromising
 * the user's Apple ID does not yield the signer private key.
 */
const SECURE_STORE_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type SnapSignerStatus = 'none' | 'pending_approval' | 'approved';

// --- Encoding helpers ---

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('Invalid hex length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * UTF-8 → base64url. Strings are encoded with `TextEncoder` so we avoid
 * the deprecated `unescape(encodeURIComponent(...))` trick and handle
 * non-ASCII input (e.g. emoji in snap inputs) correctly.
 */
function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = globalThis.btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- Key management ---

/** Get or create an Ed25519 keypair for the given fid. */
export async function getOrCreateSnapKey(fid: number): Promise<{
  publicKey: `0x${string}`;
  privateKey: Uint8Array;
  isNew: boolean;
}> {
  const storageKey = `${SNAP_KEY_PREFIX}${fid}`;
  const existing = await SecureStore.getItemAsync(storageKey);

  if (existing && /^[0-9a-f]{64}$/i.test(existing)) {
    const privateKey = hexToBytes(existing);
    const publicKey = ed.getPublicKey(privateKey);
    return {
      publicKey: `0x${bytesToHex(publicKey)}` as `0x${string}`,
      privateKey,
      isNew: false,
    };
  }

  if (existing) {
    await SecureStore.deleteItemAsync(storageKey);
  }

  const privateKey = ed.utils.randomSecretKey();
  const publicKey = ed.getPublicKey(privateKey);
  await SecureStore.setItemAsync(storageKey, bytesToHex(privateKey), SECURE_STORE_OPTS);
  return {
    publicKey: `0x${bytesToHex(publicKey)}` as `0x${string}`,
    privateKey,
    isNew: true,
  };
}

async function writeApprovedCache(fid: number): Promise<void> {
  await SecureStore.setItemAsync(`${SNAP_STATUS_PREFIX}${fid}`, 'approved', SECURE_STORE_OPTS);
}

async function clearApprovedCache(fid: number): Promise<void> {
  await SecureStore.deleteItemAsync(`${SNAP_STATUS_PREFIX}${fid}`);
}

/**
 * Read the persistent approved cache. Once `approved` is stored it stays
 * until `invalidateSnapSigner` clears it — revocation is externally
 * triggered and rare, so we rely on submit-failure feedback instead of
 * periodic refresh.
 */
async function readApprovedCache(fid: number): Promise<SnapSignerStatus | null> {
  const cached = await SecureStore.getItemAsync(`${SNAP_STATUS_PREFIX}${fid}`);
  return cached === 'approved' ? 'approved' : null;
}

/**
 * Check whether the snap signer for this fid is registered & approved.
 *
 * Fast path: if SecureStore has `approved`, returns immediately without any
 * network call. Pass `{ force: true }` to bypass the cache and re-check with
 * the backend (used by the AppState-driven post-approval confirmation).
 */
export async function getSnapSignerStatus(
  fid: number,
  opts: { force?: boolean } = {},
): Promise<SnapSignerStatus> {
  if (!opts.force) {
    const cached = await readApprovedCache(fid);
    if (cached) return cached;
  }

  const storageKey = `${SNAP_KEY_PREFIX}${fid}`;
  const existing = await SecureStore.getItemAsync(storageKey);
  if (!existing) return 'none';
  if (!/^[0-9a-f]{64}$/i.test(existing)) {
    await SecureStore.deleteItemAsync(storageKey);
    return 'none';
  }

  const { publicKey } = await getOrCreateSnapKey(fid);
  try {
    const result = await api.getSnapSignerStatus(publicKey);
    if (result.status === 'approved') {
      await writeApprovedCache(fid);
      return 'approved';
    }
    await clearApprovedCache(fid);
    return result.status === 'pending_approval' ? 'pending_approval' : 'none';
  } catch {
    return 'none';
  }
}

/** Register the on-device Ed25519 pubkey via backend + Neynar. */
export async function registerSnapSigner(fid: number): Promise<{
  publicKey: string;
  approvalUrl: string | null;
  status: string;
}> {
  const { publicKey } = await getOrCreateSnapKey(fid);
  const result = await api.registerSnapSigner(publicKey);

  if (result.status === 'approved') {
    await writeApprovedCache(fid);
  }

  return {
    publicKey: result.public_key,
    approvalUrl: result.approval_url,
    status: result.status,
  };
}

/**
 * Clear the locally cached signer status and tell the backend to mark the
 * signer revoked. Called after a snap submit fails with a "signer revoked"
 * shape, which is our only invalidation signal (Neynar does not provide
 * signer lifecycle webhooks).
 *
 * The backend call swallows 404 so the frontend can ship before the new
 * endpoint lands.
 */
export async function invalidateSnapSigner(fid: number): Promise<void> {
  await clearApprovedCache(fid);
  try {
    const { publicKey } = await getOrCreateSnapKey(fid);
    await api.invalidateSnapSigner(publicKey);
  } catch {
    // Best-effort: local state is already cleared.
  }
}

// --- JFS signing ---

export interface SnapSubmitPayload {
  fid: number;
  inputs: Record<string, string | number | boolean>;
  nonce: string;
  audience: string;
  timestamp: number;
}

export interface JfsBody {
  header: string;
  payload: string;
  signature: string;
}

/**
 * Build a JSON Farcaster Signature body for a snap submit request.
 *
 * Returns the JSON shape accepted by @farcaster/snap server:
 * `{ header, payload, signature }` where each field is base64url-encoded.
 *
 * Snap v2 requires `nonce` and `audience` in the signed payload. `audience`
 * binds the signature to the snap server origin (scheme+host+port) and
 * `nonce` defeats replay. Per-button discrimination is now carried by the
 * POST `target` URL, not a `button_index` claim.
 */
export async function signSnapSubmit(
  fid: number,
  inputs: Record<string, string | number | boolean>,
  { audience }: { audience: string },
): Promise<JfsBody> {
  const { publicKey, privateKey } = await getOrCreateSnapKey(fid);

  const header = {
    fid,
    type: 'app_key',
    key: publicKey,
  };
  const nonceBytes = await Crypto.getRandomBytesAsync(16);
  const payload: SnapSubmitPayload = {
    fid,
    inputs,
    nonce: base64UrlEncode(nonceBytes),
    audience,
    timestamp: Math.floor(Date.now() / 1000),
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));

  const signingInput = `${headerB64}.${payloadB64}`;
  const signingBytes = new TextEncoder().encode(signingInput);
  const signatureBytes = ed.sign(signingBytes, privateKey);
  const signatureB64 = base64UrlEncode(signatureBytes);

  return {
    header: headerB64,
    payload: payloadB64,
    signature: signatureB64,
  };
}

/**
 * v1 JFS payload shape, retained for the v1 fallback path per the v2
 * client-upgrade doc (try v2 first, retry as v1 on 4xx).
 */
export interface SnapSubmitPayloadV1 {
  fid: number;
  inputs: Record<string, string | number | boolean>;
  button_index: number;
  timestamp: number;
}

/**
 * Build a v1 JFS body. Used only as the fallback when a v2 submit is
 * rejected with a 4xx — see `SnapCard.submitButton`. No `nonce` / `audience`:
 * v1 servers reject non-standard fields.
 */
export async function signSnapSubmitV1(
  fid: number,
  buttonIndex: number,
  inputs: Record<string, string | number | boolean>,
): Promise<JfsBody> {
  const { publicKey, privateKey } = await getOrCreateSnapKey(fid);

  const header = {
    fid,
    type: 'app_key',
    key: publicKey,
  };
  const payload: SnapSubmitPayloadV1 = {
    fid,
    inputs,
    button_index: buttonIndex,
    timestamp: Math.floor(Date.now() / 1000),
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = ed.sign(signingBytes, privateKey);
  const signatureB64 = base64UrlEncode(signatureBytes);

  return { header: headerB64, payload: payloadB64, signature: signatureB64 };
}
