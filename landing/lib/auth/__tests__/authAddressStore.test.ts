import {
  createAuthAddressStore,
  type AuthAddressBackend,
  type StoredAuthAddress,
} from "@/lib/auth/authAddressStore";

function createMemoryBackend(): AuthAddressBackend & {
  records: Map<number, StoredAuthAddress>;
  wrappingKey: CryptoKey | null;
} {
  const state = {
    records: new Map<number, StoredAuthAddress>(),
    wrappingKey: null as CryptoKey | null,
    async getWrappingKey() {
      return state.wrappingKey;
    },
    async putWrappingKey(key: CryptoKey) {
      state.wrappingKey = key;
    },
    async getRecord(fid: number) {
      return state.records.get(fid) ?? null;
    },
    async putRecord(record: StoredAuthAddress) {
      state.records.set(record.fid, record);
    },
    async deleteRecord(fid: number) {
      state.records.delete(fid);
    },
  };
  return state;
}

describe("createAuthAddressStore", () => {
  it("returns null when nothing is stored", async () => {
    const store = createAuthAddressStore(createMemoryBackend());
    expect(await store.load(1)).toBeNull();
  });

  it("creates, wraps and reloads the same key", async () => {
    const backend = createMemoryBackend();
    const store = createAuthAddressStore(backend);
    const created = await store.loadOrCreate(7);

    const record = backend.records.get(7);
    expect(record?.address).toBe(created.address);
    // The private key is never at rest in plaintext.
    const ciphertext = new TextDecoder().decode(record!.ciphertext);
    expect(ciphertext).not.toMatch(/^0x[0-9a-f]{64}$/i);

    expect(backend.wrappingKey?.extractable).toBe(false);
    const reloaded = await store.load(7);
    expect(reloaded?.address).toBe(created.address);
    expect((await store.loadOrCreate(7)).address).toBe(created.address);
  });

  it("keeps one key per fid", async () => {
    const store = createAuthAddressStore(createMemoryBackend());
    const first = await store.loadOrCreate(1);
    const second = await store.loadOrCreate(2);
    expect(first.address).not.toBe(second.address);
  });

  it("drops a record that no longer decrypts", async () => {
    const backend = createMemoryBackend();
    const store = createAuthAddressStore(backend);
    await store.loadOrCreate(3);
    const record = backend.records.get(3)!;
    const tampered = new Uint8Array(record.ciphertext.slice(0));
    tampered[0] ^= 0xff;
    backend.records.set(3, { ...record, ciphertext: tampered.buffer });

    expect(await store.load(3)).toBeNull();
    expect(backend.records.has(3)).toBe(false);
  });

  it("drops a record whose address does not match its key", async () => {
    const backend = createMemoryBackend();
    const store = createAuthAddressStore(backend);
    await store.loadOrCreate(4);
    const record = backend.records.get(4)!;
    backend.records.set(4, {
      ...record,
      address: "0x0000000000000000000000000000000000000001",
    });

    expect(await store.load(4)).toBeNull();
    expect(backend.records.has(4)).toBe(false);
  });

  it("drops records when the wrapping key is lost", async () => {
    const backend = createMemoryBackend();
    const store = createAuthAddressStore(backend);
    await store.loadOrCreate(5);
    backend.wrappingKey = null;

    expect(await store.load(5)).toBeNull();
    expect(backend.records.has(5)).toBe(false);
  });

  it("removes a key on request and validates the fid", async () => {
    const backend = createMemoryBackend();
    const store = createAuthAddressStore(backend);
    await store.loadOrCreate(6);
    await store.remove(6);
    expect(backend.records.has(6)).toBe(false);
    await expect(store.load(0)).rejects.toThrow();
  });
});
