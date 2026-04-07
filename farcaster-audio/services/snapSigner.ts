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
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import * as api from '@/services/api';

// Wire the hash implementation — required by @noble/ed25519 v3.
ed.hashes.sha512 = sha512;

const SNAP_KEY_PREFIX = 'snap_signer_key_';
const SNAP_STATUS_PREFIX = 'snap_signer_status_';
const SNAP_STATUS_TS_PREFIX = 'snap_signer_status_ts_';

/**
 * Cached "approved" status is valid for one hour. After that we re-check
 * with the backend so that revoked or rotated signers stop being trusted.
 */
const STATUS_CACHE_TTL_MS = 60 * 60 * 1000;

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

function base64UrlEncode(input: string | Uint8Array): string {
  let b64: string;
  if (typeof input === 'string') {
    // btoa requires latin1; JSON/ASCII is fine
    b64 = globalThis.btoa(unescape(encodeURIComponent(input)));
  } else {
    let bin = '';
    for (let i = 0; i < input.length; i++) bin += String.fromCharCode(input[i]);
    b64 = globalThis.btoa(bin);
  }
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

async function writeStatusCache(fid: number, value: SnapSignerStatus): Promise<void> {
  await SecureStore.setItemAsync(`${SNAP_STATUS_PREFIX}${fid}`, value, SECURE_STORE_OPTS);
  await SecureStore.setItemAsync(
    `${SNAP_STATUS_TS_PREFIX}${fid}`,
    String(Date.now()),
    SECURE_STORE_OPTS,
  );
}

async function readFreshStatusCache(fid: number): Promise<SnapSignerStatus | null> {
  const cached = await SecureStore.getItemAsync(`${SNAP_STATUS_PREFIX}${fid}`);
  if (cached !== 'approved') return null;
  const tsRaw = await SecureStore.getItemAsync(`${SNAP_STATUS_TS_PREFIX}${fid}`);
  const ts = tsRaw ? Number(tsRaw) : 0;
  if (!ts || Date.now() - ts > STATUS_CACHE_TTL_MS) return null;
  return 'approved';
}

/** Check whether the snap signer for this fid is registered & approved. */
export async function getSnapSignerStatus(fid: number): Promise<SnapSignerStatus> {
  const fresh = await readFreshStatusCache(fid);
  if (fresh) return fresh;

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
      await writeStatusCache(fid, 'approved');
      return 'approved';
    }
    // Clear stale cache if upstream no longer reports approved.
    await SecureStore.deleteItemAsync(`${SNAP_STATUS_PREFIX}${fid}`);
    await SecureStore.deleteItemAsync(`${SNAP_STATUS_TS_PREFIX}${fid}`);
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
    await writeStatusCache(fid, 'approved');
  }

  return {
    publicKey: result.public_key,
    approvalUrl: result.approval_url,
    status: result.status,
  };
}

// --- JFS signing ---

export interface SnapSubmitPayload {
  fid: number;
  inputs: Record<string, string | number | boolean>;
  button_index: number;
  timestamp: number;
  /** Target URL this body is signed for — prevents cross-origin replay. */
  aud: string;
  /** Random per-request nonce — prevents same-origin replay. */
  nonce: string;
}

export interface JfsBody {
  header: string;
  payload: string;
  signature: string;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

/**
 * Build a JSON Farcaster Signature body for a snap submit request.
 *
 * Returns the JSON shape accepted by @farcaster/snap server:
 * `{ header, payload, signature }` where each field is base64url-encoded.
 *
 * The payload is bound to `audience` (the target URL being POSTed to) and
 * includes a random nonce to defeat cross-origin replay and capture-replay
 * attacks. These fields are additive — standards-compliant snap servers
 * that ignore unknown payload fields will still accept the body.
 */
export async function signSnapSubmit(
  fid: number,
  buttonIndex: number,
  inputs: Record<string, string | number | boolean>,
  audience: string,
): Promise<JfsBody> {
  const { publicKey, privateKey } = await getOrCreateSnapKey(fid);

  const header = {
    fid,
    type: 'app_key',
    key: publicKey,
  };
  const payload: SnapSubmitPayload = {
    fid,
    inputs,
    button_index: buttonIndex,
    timestamp: Math.floor(Date.now() / 1000),
    aud: audience,
    nonce: randomNonce(),
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
