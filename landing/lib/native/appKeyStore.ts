/**
 * IndexedDB persistence for the Farcaster on-device Ed25519 "app key".
 *
 * Web analog of the mobile `expo-secure-store` usage in `snapSigner.ts`. The
 * key material is an app key (revocable from the Farcaster client), not the
 * user's custody key — but we still scope it per-fid and never send the
 * private key anywhere.
 *
 * Storage (IndexedDB, database `juke-appkey`, one key-value store):
 *   - a random AES-GCM-256 wrapping key, generated NON-EXTRACTABLE by
 *     WebCrypto and persisted as a `CryptoKey` (structured clone keeps it
 *     opaque) — the same scheme as `lib/auth/authAddressStore.ts`;
 *   - per FID, the Ed25519 private key hex encrypted under that wrapping key.
 *
 * Builds before this stored the hex in plaintext. A plaintext entry is
 * re-wrapped and overwritten the first time it is read.
 *
 * Threat model, honestly: WebCrypto Ed25519 support is not universal and the
 * JFS signer needs the raw scalar, so the signing key itself can't be
 * non-extractable. Wrapping means a copy of the on-disk profile (backup,
 * sync, forensic dump) does not yield the key; script running in the
 * juke.audio origin (XSS) can still unwrap it. The key is revocable and the
 * higher-value credential (the Juke refresh token) stays in an HttpOnly
 * cookie.
 */

const AES_KEY_LENGTH_BITS = 256;
const AES_GCM_IV_BYTES = 12;
const PRIVATE_KEY_HEX_PATTERN = /^[0-9a-f]{64}$/i;

const KEY_PREFIX = "key:";
const STATUS_PREFIX = "status:";
const WRAPPING_KEY_ID = "wrap:v1";

/** An encrypted private key as persisted. */
export interface WrappedAppKey {
  readonly v: 1;
  readonly iv: Uint8Array;
  readonly ciphertext: ArrayBuffer;
}

/** Anything the store may find under a key (legacy rows are plain strings). */
export type StoredValue = string | WrappedAppKey | CryptoKey;

/** Persistence port — IndexedDB in the browser, an in-memory map in tests. */
export interface AppKeyBackend {
  get(key: string): Promise<unknown>;
  put(key: string, value: StoredValue): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AppKeyStore {
  /** The stored private key hex for a fid (no 0x), or null. */
  getPrivateKeyHex(fid: number): Promise<string | null>;
  setPrivateKeyHex(fid: number, hex: string): Promise<void>;
  deletePrivateKey(fid: number): Promise<void>;
  readApprovedCache(fid: number): Promise<boolean>;
  writeApprovedCache(fid: number): Promise<void>;
  clearApprovedCache(fid: number): Promise<void>;
}

// After this long the fast-path re-checks the backend, so a key revoked in
// the Farcaster client stops reporting locally-approved within the window.
const APPROVED_TTL_MS = 12 * 60 * 60 * 1000;

// Tag checks rather than `instanceof`: values can come from another realm
// (structured clone, jest's VM context).
function hasTag(value: unknown, tag: string): boolean {
  return Object.prototype.toString.call(value) === `[object ${tag}]`;
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return hasTag(value, "CryptoKey");
}

function isWrappedAppKey(value: unknown): value is WrappedAppKey {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<WrappedAppKey>;
  return (
    record.v === 1 &&
    hasTag(record.iv, "Uint8Array") &&
    hasTag(record.ciphertext, "ArrayBuffer")
  );
}

export function createAppKeyStore(backend: AppKeyBackend): AppKeyStore {
  async function existingWrappingKey(): Promise<CryptoKey | null> {
    const key = await backend.get(WRAPPING_KEY_ID);
    return isCryptoKey(key) ? key : null;
  }

  // Memoized so concurrent first writes in this tab share one wrapping key
  // instead of each generating (and overwriting) their own.
  let wrappingKeyPromise: Promise<CryptoKey> | null = null;

  function wrappingKey(): Promise<CryptoKey> {
    wrappingKeyPromise ??= (async () => {
      const existing = await existingWrappingKey();
      if (existing) return existing;
      const key = await subtle().generateKey(
        { name: "AES-GCM", length: AES_KEY_LENGTH_BITS },
        false,
        ["encrypt", "decrypt"],
      );
      await backend.put(WRAPPING_KEY_ID, key);
      return key;
    })().catch((err: unknown) => {
      wrappingKeyPromise = null;
      throw err;
    });
    return wrappingKeyPromise;
  }

  async function wrap(hex: string): Promise<WrappedAppKey> {
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const ciphertext = await subtle().encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      await wrappingKey(),
      new TextEncoder().encode(hex),
    );
    return { v: 1, iv, ciphertext };
  }

  async function unwrap(record: WrappedAppKey): Promise<string | null> {
    const key = await existingWrappingKey();
    if (!key) return null;
    try {
      const plaintext = await subtle().decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(record.iv) },
        key,
        record.ciphertext,
      );
      return new TextDecoder().decode(plaintext);
    } catch {
      return null;
    }
  }

  async function setPrivateKeyHex(fid: number, hex: string): Promise<void> {
    assertFid(fid);
    if (!PRIVATE_KEY_HEX_PATTERN.test(hex)) {
      throw new RangeError("app key must be 32 bytes of hex");
    }
    await backend.put(`${KEY_PREFIX}${fid}`, await wrap(hex));
  }

  async function getPrivateKeyHex(fid: number): Promise<string | null> {
    assertFid(fid);
    const slot = `${KEY_PREFIX}${fid}`;
    const stored = await backend.get(slot);
    if (stored === undefined || stored === null) return null;

    if (typeof stored === "string") {
      // Legacy plaintext row: migrate in place, then hand the key back.
      if (!PRIVATE_KEY_HEX_PATTERN.test(stored)) {
        await backend.delete(slot);
        return null;
      }
      await backend.put(slot, await wrap(stored));
      return stored;
    }

    const hex = isWrappedAppKey(stored) ? await unwrap(stored) : null;
    if (hex === null || !PRIVATE_KEY_HEX_PATTERN.test(hex)) {
      // Unrecoverable (wrapping key gone, tampered, or unknown shape).
      await backend.delete(slot);
      return null;
    }
    return hex;
  }

  async function deletePrivateKey(fid: number): Promise<void> {
    assertFid(fid);
    await backend.delete(`${KEY_PREFIX}${fid}`);
  }

  async function readApprovedCache(fid: number): Promise<boolean> {
    const raw = await backend.get(`${STATUS_PREFIX}${fid}`);
    if (typeof raw !== "string" || raw.length === 0) return false;
    const at = Number(raw);
    return Number.isFinite(at) && Date.now() - at < APPROVED_TTL_MS;
  }

  function writeApprovedCache(fid: number): Promise<void> {
    return backend.put(`${STATUS_PREFIX}${fid}`, String(Date.now()));
  }

  function clearApprovedCache(fid: number): Promise<void> {
    return backend.delete(`${STATUS_PREFIX}${fid}`);
  }

  return {
    getPrivateKeyHex,
    setPrivateKeyHex,
    deletePrivateKey,
    readApprovedCache,
    writeApprovedCache,
    clearApprovedCache,
  };
}

// ---------------------------------------------------------------------------
// IndexedDB backend
// ---------------------------------------------------------------------------

const DB_NAME = "juke-appkey";
const STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

async function runTransaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB aborted"));
    });
  } finally {
    db.close();
  }
}

export function createIndexedDbAppKeyBackend(): AppKeyBackend {
  return {
    get: (key) => runTransaction<unknown>("readonly", (s) => s.get(key)),
    put: async (key, value) => {
      await runTransaction("readwrite", (s) => s.put(value, key));
    },
    delete: async (key) => {
      await runTransaction("readwrite", (s) => s.delete(key));
    },
  };
}

let browserStore: AppKeyStore | null = null;

function store(): AppKeyStore {
  browserStore ??= createAppKeyStore(createIndexedDbAppKeyBackend());
  return browserStore;
}

// Module-level API kept for existing callers (`lib/native/appKey.ts`, hooks).

/** The stored private key hex for a fid (no 0x), or null. */
export function getStoredPrivateKeyHex(fid: number): Promise<string | null> {
  return store().getPrivateKeyHex(fid);
}

export function setStoredPrivateKeyHex(
  fid: number,
  hex: string,
): Promise<void> {
  return store().setPrivateKeyHex(fid, hex);
}

export function deleteStoredPrivateKey(fid: number): Promise<void> {
  return store().deletePrivateKey(fid);
}

/** Cached "approved" flag (fast path so we skip a network status check). */
export function readApprovedCache(fid: number): Promise<boolean> {
  return store().readApprovedCache(fid);
}

export function writeApprovedCache(fid: number): Promise<void> {
  return store().writeApprovedCache(fid);
}

export function clearApprovedCache(fid: number): Promise<void> {
  return store().clearApprovedCache(fid);
}

// ---------------------------------------------------------------------------

function subtle(): SubtleCrypto {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new Error("WebCrypto is unavailable; can't protect the app key.");
  }
  return crypto.subtle;
}

function assertFid(fid: number): void {
  if (!Number.isSafeInteger(fid) || fid <= 0) {
    throw new RangeError("fid must be a positive integer");
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
