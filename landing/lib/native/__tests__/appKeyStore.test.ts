import {
  createAppKeyStore,
  type AppKeyBackend,
  type StoredValue,
} from "@/lib/native/appKeyStore";

const KEY_HEX = "a1".repeat(32);
const OTHER_KEY_HEX = "b2".repeat(32);

function createMemoryBackend(): AppKeyBackend & {
  data: Map<string, StoredValue>;
} {
  const data = new Map<string, StoredValue>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

function plaintextHexValues(data: Map<string, StoredValue>): string[] {
  return [...data.values()].filter(
    (value): value is string =>
      typeof value === "string" && /^[0-9a-f]{64}$/i.test(value),
  );
}

describe("createAppKeyStore", () => {
  it("returns null when nothing is stored", async () => {
    const store = createAppKeyStore(createMemoryBackend());
    expect(await store.getPrivateKeyHex(1)).toBeNull();
  });

  it("never persists the private key in plaintext", async () => {
    const backend = createMemoryBackend();
    const store = createAppKeyStore(backend);
    await store.setPrivateKeyHex(7, KEY_HEX);

    expect(plaintextHexValues(backend.data)).toEqual([]);
    const record = backend.data.get("key:7");
    expect(typeof record).toBe("object");
    expect(JSON.stringify(record)).not.toContain(KEY_HEX);
    const wrappingKey = backend.data.get("wrap:v1") as CryptoKey;
    expect(wrappingKey.extractable).toBe(false);
    expect(wrappingKey.algorithm.name).toBe("AES-GCM");
  });

  it("round-trips a wrapped key", async () => {
    const store = createAppKeyStore(createMemoryBackend());
    await store.setPrivateKeyHex(7, KEY_HEX);
    expect(await store.getPrivateKeyHex(7)).toBe(KEY_HEX);
  });

  it("reads a wrapped key back through a fresh store instance", async () => {
    const backend = createMemoryBackend();
    await createAppKeyStore(backend).setPrivateKeyHex(7, KEY_HEX);
    expect(await createAppKeyStore(backend).getPrivateKeyHex(7)).toBe(KEY_HEX);
  });

  it("migrates a legacy plaintext entry by re-wrapping it in place", async () => {
    const backend = createMemoryBackend();
    backend.data.set("key:9", KEY_HEX);
    const store = createAppKeyStore(backend);

    expect(await store.getPrivateKeyHex(9)).toBe(KEY_HEX);
    expect(plaintextHexValues(backend.data)).toEqual([]);
    expect(typeof backend.data.get("key:9")).toBe("object");
    expect(await createAppKeyStore(backend).getPrivateKeyHex(9)).toBe(KEY_HEX);
  });

  it("drops a malformed legacy entry", async () => {
    const backend = createMemoryBackend();
    backend.data.set("key:9", "not-a-key");
    const store = createAppKeyStore(backend);
    expect(await store.getPrivateKeyHex(9)).toBeNull();
    expect(backend.data.has("key:9")).toBe(false);
  });

  it("drops a record whose wrapping key is gone", async () => {
    const backend = createMemoryBackend();
    await createAppKeyStore(backend).setPrivateKeyHex(7, KEY_HEX);
    backend.data.delete("wrap:v1");
    expect(await createAppKeyStore(backend).getPrivateKeyHex(7)).toBeNull();
    expect(backend.data.has("key:7")).toBe(false);
  });

  it("drops a tampered ciphertext", async () => {
    const backend = createMemoryBackend();
    const store = createAppKeyStore(backend);
    await store.setPrivateKeyHex(7, KEY_HEX);
    const record = backend.data.get("key:7") as {
      v: 1;
      iv: Uint8Array;
      ciphertext: ArrayBuffer;
    };
    const tampered = new Uint8Array(record.ciphertext.slice(0));
    tampered[0] ^= 0xff;
    backend.data.set("key:7", { ...record, ciphertext: tampered.buffer });
    expect(await store.getPrivateKeyHex(7)).toBeNull();
    expect(backend.data.has("key:7")).toBe(false);
  });

  it("shares one wrapping key across concurrent first writes", async () => {
    const backend = createMemoryBackend();
    const store = createAppKeyStore(backend);
    await Promise.all([
      store.setPrivateKeyHex(1, KEY_HEX),
      store.setPrivateKeyHex(2, OTHER_KEY_HEX),
    ]);
    expect(await store.getPrivateKeyHex(1)).toBe(KEY_HEX);
    expect(await store.getPrivateKeyHex(2)).toBe(OTHER_KEY_HEX);
  });

  it("scopes keys per fid and deletes them", async () => {
    const store = createAppKeyStore(createMemoryBackend());
    await store.setPrivateKeyHex(1, KEY_HEX);
    await store.setPrivateKeyHex(2, OTHER_KEY_HEX);
    await store.deletePrivateKey(1);
    expect(await store.getPrivateKeyHex(1)).toBeNull();
    expect(await store.getPrivateKeyHex(2)).toBe(OTHER_KEY_HEX);
  });

  it("rejects malformed keys and fids", async () => {
    const store = createAppKeyStore(createMemoryBackend());
    await expect(store.setPrivateKeyHex(1, "abc")).rejects.toThrow(RangeError);
    await expect(store.setPrivateKeyHex(0, KEY_HEX)).rejects.toThrow(RangeError);
  });

  it("keeps the approved cache behaviour", async () => {
    const store = createAppKeyStore(createMemoryBackend());
    expect(await store.readApprovedCache(1)).toBe(false);
    await store.writeApprovedCache(1);
    expect(await store.readApprovedCache(1)).toBe(true);
    await store.clearApprovedCache(1);
    expect(await store.readApprovedCache(1)).toBe(false);
  });
});
