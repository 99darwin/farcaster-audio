/**
 * Browser-held Farcaster auth address (KeyRegistry keyType 2) for the web app.
 *
 * Each browser generates its own secp256k1 key per FID. After a one-time link
 * with the recovery phrase it is listed on-chain for the FID, so every later
 * login is a Protocol Auth token signed by this key — no phrase, no popup.
 *
 * Storage (IndexedDB, database `juke-auth`):
 *   - a random AES-GCM-256 wrapping key, generated NON-EXTRACTABLE by WebCrypto
 *     and persisted as a `CryptoKey` object (structured clone keeps it opaque);
 *   - per FID, the secp256k1 private key encrypted under that wrapping key.
 *
 * Threat model, honestly: WebCrypto has no secp256k1, so the signing key
 * itself can't be non-extractable. Wrapping it means a copy of the on-disk
 * profile (backup, sync, forensic dump) does not yield the key, but script
 * running in the juke.audio origin (XSS) can still ask WebCrypto to unwrap it
 * and sign. The auth address can only authenticate as the FID — it can't move
 * the FID or add keys — and the user can revoke it in KeyRegistry.
 */

import type { Hex, LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const AES_KEY_LENGTH_BITS = 256;
const AES_GCM_IV_BYTES = 12;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-f]{64}$/i;

export interface StoredAuthAddress {
  readonly fid: number;
  readonly address: Hex;
  readonly iv: Uint8Array;
  readonly ciphertext: ArrayBuffer;
  readonly createdAt: number;
}

/** Persistence port — IndexedDB in the browser, an in-memory map in tests. */
export interface AuthAddressBackend {
  getWrappingKey(): Promise<CryptoKey | null>;
  putWrappingKey(key: CryptoKey): Promise<void>;
  getRecord(fid: number): Promise<StoredAuthAddress | null>;
  putRecord(record: StoredAuthAddress): Promise<void>;
  deleteRecord(fid: number): Promise<void>;
}

export class AuthAddressStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthAddressStorageError";
  }
}

export interface AuthAddressStore {
  /** The stored account for `fid`, or null when this browser has none. */
  load(fid: number): Promise<LocalAccount | null>;
  /** The stored account, generating and persisting a fresh one if missing. */
  loadOrCreate(fid: number): Promise<LocalAccount>;
  /** Forget the key for `fid` (e.g. after it was revoked on-chain). */
  remove(fid: number): Promise<void>;
}

export function createAuthAddressStore(
  backend: AuthAddressBackend,
): AuthAddressStore {
  async function wrappingKey(): Promise<CryptoKey> {
    const existing = await backend.getWrappingKey();
    if (existing) return existing;
    const key = await subtle().generateKey(
      { name: "AES-GCM", length: AES_KEY_LENGTH_BITS },
      false,
      ["encrypt", "decrypt"],
    );
    await backend.putWrappingKey(key);
    return key;
  }

  async function load(fid: number): Promise<LocalAccount | null> {
    assertFid(fid);
    const record = await backend.getRecord(fid);
    if (!record) return null;
    const key = await backend.getWrappingKey();
    if (!key) {
      // The wrapping key is gone, so the record is unrecoverable.
      await backend.deleteRecord(fid);
      return null;
    }
    let privateKey: string;
    try {
      const plaintext = await subtle().decrypt(
        { name: "AES-GCM", iv: toArrayBuffer(record.iv) },
        key,
        record.ciphertext,
      );
      privateKey = new TextDecoder().decode(plaintext);
    } catch {
      await backend.deleteRecord(fid);
      return null;
    }
    if (!PRIVATE_KEY_PATTERN.test(privateKey)) {
      await backend.deleteRecord(fid);
      return null;
    }
    const account = privateKeyToAccount(privateKey as Hex);
    if (account.address.toLowerCase() !== record.address.toLowerCase()) {
      await backend.deleteRecord(fid);
      return null;
    }
    return account;
  }

  async function loadOrCreate(fid: number): Promise<LocalAccount> {
    const existing = await load(fid);
    if (existing) return existing;

    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
    const ciphertext = await subtle().encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      await wrappingKey(),
      new TextEncoder().encode(privateKey),
    );
    await backend.putRecord({
      fid,
      address: account.address,
      iv,
      ciphertext,
      createdAt: Date.now(),
    });
    return account;
  }

  async function remove(fid: number): Promise<void> {
    assertFid(fid);
    await backend.deleteRecord(fid);
  }

  return { load, loadOrCreate, remove };
}

// ---------------------------------------------------------------------------
// IndexedDB backend
// ---------------------------------------------------------------------------

const DB_NAME = "juke-auth";
const DB_VERSION = 1;
const KEYS_STORE = "wrapping-keys";
const RECORDS_STORE = "auth-addresses";
const WRAPPING_KEY_ID = "auth-address-wrap";

export function createIndexedDbBackend(): AuthAddressBackend {
  let dbPromise: Promise<IDBDatabase> | null = null;

  function db(): Promise<IDBDatabase> {
    if (typeof indexedDB === "undefined") {
      return Promise.reject(
        new AuthAddressStorageError(
          "This browser can't store a sign-in key (IndexedDB is unavailable).",
        ),
      );
    }
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(KEYS_STORE)) {
          database.createObjectStore(KEYS_STORE);
        }
        if (!database.objectStoreNames.contains(RECORDS_STORE)) {
          database.createObjectStore(RECORDS_STORE, { keyPath: "fid" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(
          new AuthAddressStorageError(
            "This browser blocked storage for the sign-in key.",
          ),
        );
      };
    });
    return dbPromise;
  }

  async function run<T>(
    storeName: string,
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest,
  ): Promise<T> {
    const database = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = database.transaction(storeName, mode);
      const request = operation(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = () =>
        reject(new AuthAddressStorageError("Sign-in key storage failed."));
      tx.onabort = () =>
        reject(new AuthAddressStorageError("Sign-in key storage failed."));
    });
  }

  return {
    async getWrappingKey() {
      const key = await run<CryptoKey | undefined>(KEYS_STORE, "readonly", (s) =>
        s.get(WRAPPING_KEY_ID),
      );
      return key ?? null;
    },
    async putWrappingKey(key) {
      await run(KEYS_STORE, "readwrite", (s) => s.put(key, WRAPPING_KEY_ID));
    },
    async getRecord(fid) {
      const record = await run<StoredAuthAddress | undefined>(
        RECORDS_STORE,
        "readonly",
        (s) => s.get(fid),
      );
      return record ?? null;
    },
    async putRecord(record) {
      await run(RECORDS_STORE, "readwrite", (s) => s.put(record));
    },
    async deleteRecord(fid) {
      await run(RECORDS_STORE, "readwrite", (s) => s.delete(fid));
    },
  };
}

let browserStore: AuthAddressStore | null = null;

/** Process-wide store backed by IndexedDB. Browser-only. */
export function getBrowserAuthAddressStore(): AuthAddressStore {
  browserStore ??= createAuthAddressStore(createIndexedDbBackend());
  return browserStore;
}

// ---------------------------------------------------------------------------

function subtle(): SubtleCrypto {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new AuthAddressStorageError(
      "This browser can't protect a sign-in key (WebCrypto is unavailable).",
    );
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
