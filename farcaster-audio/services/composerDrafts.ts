/**
 * Unsent composer text per thread, persisted in AsyncStorage so a draft
 * survives leaving the thread and app restarts. Keys carry the viewer fid
 * so accounts on one device never see each other's drafts; sign-out clears
 * them all.
 *
 * Drafts are a convenience: storage failures are swallowed so they can
 * never block typing, sending or signing out.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

const DRAFT_KEY_PREFIX = "messages:draft:";

/** Storage key for one viewer's draft in one thread (conversation or draft key). */
export function composerDraftKey(viewerFid: number, threadKey: string): string | null {
  if (!Number.isSafeInteger(viewerFid) || viewerFid <= 0 || !threadKey) return null;
  return `${DRAFT_KEY_PREFIX}${viewerFid}:${threadKey}`;
}

export async function loadComposerDraft(key: string): Promise<string | null> {
  try {
    const value = await AsyncStorage.getItem(key);
    return value && value.trim().length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Save `text`, or remove the draft when it is blank. */
export async function saveComposerDraft(key: string, text: string): Promise<void> {
  try {
    if (text.trim().length === 0) {
      await AsyncStorage.removeItem(key);
      return;
    }
    await AsyncStorage.setItem(key, text);
  } catch {
    // Best effort; see the module note.
  }
}

export async function clearComposerDraft(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch {
    // Best effort; see the module note.
  }
}

/** Remove every viewer's drafts (sign-out). */
export async function clearAllComposerDrafts(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const draftKeys = keys.filter((key) => key.startsWith(DRAFT_KEY_PREFIX));
    if (draftKeys.length > 0) await AsyncStorage.multiRemove(draftKeys);
  } catch {
    // Best effort; see the module note.
  }
}
