/**
 * Persisted per-thread composer drafts: key scoping, storage failures, and
 * the store / sign-out wiring.
 */

jest.mock("@/lib/api/messages", () => ({
  ...jest.requireActual("@/lib/api/messages"),
  sendMessage: jest.fn(() => new Promise(() => {})),
}));
jest.mock("@/lib/auth/session", () => ({
  getJwt: jest.fn(() => null),
  getUser: jest.fn(() => null),
  setSession: jest.fn(),
  clearSession: jest.fn(),
}));
jest.mock("@/lib/auth/authRefresh", () => ({ refreshSession: jest.fn() }));

import {
  DRAFT_KEY_PREFIX,
  clearAllPersistedDrafts,
  clearPersistedDraft,
  draftStorageKey,
  loadPersistedDraft,
  persistDraft,
  type DraftStorage,
} from "@/lib/messages/draft-storage";
import { draftConversationKey, useMessageStore } from "@/lib/stores/messageStore";
import { useAuthStore } from "@/lib/stores/authStore";
import { ALICE, BOB } from "@/lib/messages/__tests__/fixtures";

class MemoryStorage implements DraftStorage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const throwing: DraftStorage = {
  length: 1,
  key: () => {
    throw new Error("SecurityError");
  },
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("draft-storage helpers", () => {
  it("scopes keys by viewer fid and conversation", () => {
    expect(draftStorageKey(1, "c1")).toBe(`${DRAFT_KEY_PREFIX}1:c1`);
    const storage = new MemoryStorage();
    persistDraft(1, "c1", "hello", storage);
    expect(loadPersistedDraft(1, "c1", storage)).toBe("hello");
    expect(loadPersistedDraft(2, "c1", storage)).toBe("");
    expect(loadPersistedDraft(1, "c2", storage)).toBe("");
  });

  it("removes the entry for blank text and on clear", () => {
    const storage = new MemoryStorage();
    persistDraft(1, "c1", "hello", storage);
    persistDraft(1, "c1", "   ", storage);
    expect(storage.length).toBe(0);
    persistDraft(1, "c1", "again", storage);
    clearPersistedDraft(1, "c1", storage);
    expect(storage.length).toBe(0);
  });

  it("clears every draft (all viewers) but leaves other keys", () => {
    const storage = new MemoryStorage();
    persistDraft(1, "c1", "a", storage);
    persistDraft(2, "c2", "b", storage);
    storage.setItem("juke:compose-draft:cast", "keep me");
    clearAllPersistedDrafts(storage);
    expect(storage.length).toBe(1);
    expect(storage.getItem("juke:compose-draft:cast")).toBe("keep me");
  });

  it("never throws when storage is blocked or missing", () => {
    expect(() => persistDraft(1, "c1", "x", throwing)).not.toThrow();
    expect(loadPersistedDraft(1, "c1", throwing)).toBe("");
    expect(() => clearAllPersistedDrafts(throwing)).not.toThrow();
    expect(loadPersistedDraft(1, "c1", null)).toBe("");
    // No `window` in this environment: the default storage is absent.
    expect(() => persistDraft(1, "c1", "x")).not.toThrow();
    expect(loadPersistedDraft(1, "c1")).toBe("");
  });
});

describe("message store + sign-out wiring", () => {
  let storage: MemoryStorage;
  const store = () => useMessageStore.getState();

  beforeEach(() => {
    storage = new MemoryStorage();
    Object.assign(globalThis, { window: { localStorage: storage } });
    store().reset();
    store().setViewer(ALICE);
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it("persists drafts as they are typed and restores them on open", () => {
    store().setDraft("c1", "half written");
    expect(storage.getItem(draftStorageKey(ALICE.fid, "c1"))).toBe("half written");

    // Reload: memory is gone, storage survives.
    store().reset();
    store().setViewer(ALICE);
    expect(store().drafts.c1).toBeUndefined();
    store().restoreDraft("c1");
    expect(store().drafts.c1).toBe("half written");
  });

  it("does not overwrite a draft already in memory, nor restore another viewer's", () => {
    persistDraft(BOB.fid, "c1", "bob's draft", storage);
    store().restoreDraft("c1");
    expect(store().drafts.c1).toBeUndefined();

    persistDraft(ALICE.fid, "c1", "stale", storage);
    useMessageStore.setState({ drafts: { c1: "live" } });
    store().restoreDraft("c1");
    expect(store().drafts.c1).toBe("live");
  });

  it("clears the persisted draft on send, including a new-peer draft key", () => {
    store().setDraft("c1", "hi");
    void store().sendMessage({ conversationId: "c1", text: "hi", replyTo: null });
    expect(storage.getItem(draftStorageKey(ALICE.fid, "c1"))).toBeNull();

    const draftKey = draftConversationKey(BOB.fid);
    store().setDraft(draftKey, "hey bob");
    void store().sendMessage({ conversationId: null, recipientFid: BOB.fid, text: "hey bob", replyTo: null });
    expect(storage.getItem(draftStorageKey(ALICE.fid, draftKey))).toBeNull();
    expect(store().drafts[draftKey]).toBe("");
  });

  it("clears all persisted drafts on sign-out", () => {
    store().setDraft("c1", "secret plans");
    useAuthStore.getState().logout();
    expect(storage.length).toBe(0);
  });
});
