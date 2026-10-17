/**
 * Per-thread composer drafts persisted in localStorage, so a half-written
 * Direct Cast survives a reload or closing the tab.
 *
 * Keys are scoped by viewer fid AND conversation key
 * (`juke:dm-draft:v1:{fid}:{conversationKey}`) so one account never sees
 * another's drafts. Every storage access is wrapped: private windows, blocked
 * site data and quota errors make storage throw or vanish, and drafts are a
 * convenience that must never break typing or sending.
 */

export const DRAFT_KEY_PREFIX = "juke:dm-draft:v1:";

/** Minimal Storage surface (lets tests pass a fake). */
export type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function defaultStorage(): DraftStorage | null {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    // Accessing `localStorage` itself throws when site data is blocked.
    return null;
  }
}

export function draftStorageKey(viewerFid: number, conversationKey: string): string {
  return `${DRAFT_KEY_PREFIX}${viewerFid}:${conversationKey}`;
}

/** The saved draft, or "" when there is none (or storage is unavailable). */
export function loadPersistedDraft(
  viewerFid: number,
  conversationKey: string,
  storage: DraftStorage | null = defaultStorage(),
): string {
  if (!storage || !conversationKey) return "";
  try {
    return storage.getItem(draftStorageKey(viewerFid, conversationKey)) ?? "";
  } catch {
    return "";
  }
}

/** Save `text`; whitespace-only text removes the entry. */
export function persistDraft(
  viewerFid: number,
  conversationKey: string,
  text: string,
  storage: DraftStorage | null = defaultStorage(),
): void {
  if (!storage || !conversationKey) return;
  const key = draftStorageKey(viewerFid, conversationKey);
  try {
    if (text.trim()) storage.setItem(key, text);
    else storage.removeItem(key);
  } catch {
    // Quota exceeded / storage blocked: the in-memory draft still works.
  }
}

export function clearPersistedDraft(
  viewerFid: number,
  conversationKey: string,
  storage: DraftStorage | null = defaultStorage(),
): void {
  persistDraft(viewerFid, conversationKey, "", storage);
}

/** Remove every persisted Direct Cast draft (all viewers): sign-out. */
export function clearAllPersistedDrafts(storage: DraftStorage | null = defaultStorage()): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key?.startsWith(DRAFT_KEY_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch {
    // Storage blocked: nothing we can clear.
  }
}
