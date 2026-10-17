/**
 * On-device Ed25519 app key + JFS bearer signing for the Juke web app.
 *
 * Byte-for-byte port of `farcaster-audio/services/snapSigner.ts`
 * (`signFarcasterClientBearer`) so the bearer is identical to what mobile
 * produces and what `client.farcaster.xyz` accepts. Only storage differs:
 * IndexedDB here vs the iOS Keychain on mobile. No React Native crypto polyfill
 * is needed — the browser provides `crypto.getRandomValues`, `TextEncoder`, and
 * `btoa` natively.
 *
 * The bearer authorizes Farcaster-native audio-room writes. It is short-lived
 * (5-minute `exp`) and single-use in spirit — mint a fresh one per request.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  getStoredPrivateKeyHex,
  setStoredPrivateKeyHex,
  deleteStoredPrivateKey,
} from "@/lib/native/appKeyStore";

// Wire the hash implementation — required by @noble/ed25519 v3.
ed.hashes.sha512 = sha512;

const HEX32 = /^[0-9a-f]{64}$/i;

// --- encoding helpers (identical to mobile) ---

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64UrlEncode(input: string | Uint8Array): string {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : input;
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = globalThis.btoa(bin);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- key management ---

/**
 * Get or create the Ed25519 keypair for a fid (private key persisted in IDB).
 * Module-private on purpose: the raw private key must never reach the public
 * API surface (React state/props/logs). Callers use `getAppKeyPublicKey` or
 * `signFarcasterClientBearer`, which expose only the public key / a signature.
 */
async function getOrCreateAppKey(fid: number): Promise<{
  publicKey: `0x${string}`;
  privateKey: Uint8Array;
  isNew: boolean;
}> {
  const existing = await getStoredPrivateKeyHex(fid);

  if (existing && HEX32.test(existing)) {
    const privateKey = hexToBytes(existing);
    const publicKey = ed.getPublicKey(privateKey);
    return {
      publicKey: `0x${bytesToHex(publicKey)}` as `0x${string}`,
      privateKey,
      isNew: false,
    };
  }

  if (existing) await deleteStoredPrivateKey(fid);

  const privateKey = ed.utils.randomSecretKey();
  const publicKey = ed.getPublicKey(privateKey);
  await setStoredPrivateKeyHex(fid, bytesToHex(privateKey));
  return {
    publicKey: `0x${bytesToHex(publicKey)}` as `0x${string}`,
    privateKey,
    isNew: true,
  };
}

/** The 0x-prefixed public key for a fid (creates the key if absent). */
export async function getAppKeyPublicKey(fid: number): Promise<`0x${string}`> {
  const { publicKey } = await getOrCreateAppKey(fid);
  return publicKey;
}

// --- JFS bearer signing (mirrors snapSigner.signFarcasterClientBearer) ---

/**
 * Sign a JFS bearer authorizing a request against `client.farcaster.xyz`
 * audio-rooms. Returns `"<headerB64>.<payloadB64>.<sigB64>"` — send it as the
 * `user_jfs_bearer` field to the Juke backend's native-room endpoints.
 */
export async function signFarcasterClientBearer(fid: number): Promise<string> {
  const { publicKey, privateKey } = await getOrCreateAppKey(fid);

  const now = Math.floor(Date.now() / 1000);
  const header = { fid, type: "app_key", key: publicKey };
  // `exp` is required by client.farcaster.xyz; 5-minute window matches mobile.
  const payload = {
    audience: "https://client.farcaster.xyz",
    timestamp: now,
    exp: now + 300,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingBytes = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signatureBytes = ed.sign(signingBytes, privateKey);
  const signatureB64 = base64UrlEncode(signatureBytes);

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}
