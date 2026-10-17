import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  clearAllComposerDrafts,
  clearComposerDraft,
  composerDraftKey,
  loadComposerDraft,
  saveComposerDraft,
} from "@/services/composerDrafts";

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.restoreAllMocks();
});

describe("composerDraftKey", () => {
  it("scopes by viewer fid and thread", () => {
    expect(composerDraftKey(3, "abc")).not.toBe(composerDraftKey(4, "abc"));
    expect(composerDraftKey(3, "abc")).not.toBe(composerDraftKey(3, "abd"));
  });

  it("has no key without a signed-in viewer or a thread", () => {
    expect(composerDraftKey(0, "abc")).toBeNull();
    expect(composerDraftKey(Number.NaN, "abc")).toBeNull();
    expect(composerDraftKey(3, "")).toBeNull();
  });
});

describe("composer draft storage", () => {
  const key = composerDraftKey(3, "abc") as string;

  it("saves, loads and clears", async () => {
    await saveComposerDraft(key, "hello");
    expect(await loadComposerDraft(key)).toBe("hello");
    await clearComposerDraft(key);
    expect(await loadComposerDraft(key)).toBeNull();
  });

  it("removes the draft when saved blank", async () => {
    await saveComposerDraft(key, "hello");
    await saveComposerDraft(key, "   ");
    expect(await AsyncStorage.getItem(key)).toBeNull();
  });

  it("clears every draft on sign-out but leaves other keys", async () => {
    await saveComposerDraft(key, "a");
    await saveComposerDraft(composerDraftKey(9, "x") as string, "b");
    await AsyncStorage.setItem("unrelated", "keep");
    await clearAllComposerDrafts();
    expect(await AsyncStorage.getAllKeys()).toEqual(["unrelated"]);
  });

  it("swallows storage failures", async () => {
    jest.spyOn(AsyncStorage, "getItem").mockRejectedValueOnce(new Error("disk"));
    jest.spyOn(AsyncStorage, "setItem").mockRejectedValueOnce(new Error("disk"));
    jest.spyOn(AsyncStorage, "getAllKeys").mockRejectedValueOnce(new Error("disk"));
    await expect(loadComposerDraft(key)).resolves.toBeNull();
    await expect(saveComposerDraft(key, "x")).resolves.toBeUndefined();
    await expect(clearAllComposerDrafts()).resolves.toBeUndefined();
  });
});
