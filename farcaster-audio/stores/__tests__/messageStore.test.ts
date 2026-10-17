import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  applyInboxPage,
  computeUnreadTotal,
  findDirectConversation,
  mergeMessages,
  toggleReactionSummary,
  useMessageStore,
  type InboxSlice,
} from "@/stores/messageStore";
import type { InboxResponse } from "@/types/messages";
import {
  BASE_TIME,
  BOB,
  makeConversation,
  makeMessage,
} from "@/components/messages/__fixtures__/messages";

const MINUTE = 60_000;

describe("mergeMessages", () => {
  it("dedupes by id, sorts newest first and confirms optimistic copies", () => {
    const optimistic = makeMessage({ message_id: "b", sent_at: BASE_TIME + 2, send_state: "sending" });
    const older = makeMessage({ message_id: "a", sent_at: BASE_TIME });
    const echo = makeMessage({ message_id: "b", sent_at: BASE_TIME + 2, text: "server" });

    const merged = mergeMessages([older, optimistic], [echo]);

    expect(merged.map((m) => m.message_id)).toEqual(["b", "a"]);
    expect(merged[0].text).toBe("server");
    expect(merged[0].send_state).toBeUndefined();
  });
});

describe("computeUnreadTotal", () => {
  it("sums unmuted conversations and counts manual-unread as one", () => {
    const conversations = {
      a: makeConversation({ conversation_id: "a", unread_count: 3 }),
      b: makeConversation({ conversation_id: "b", unread_count: 5, muted: true }),
      c: makeConversation({ conversation_id: "c", manually_marked_unread: true }),
    };
    expect(computeUnreadTotal(["a", "b", "c", "missing"], conversations)).toBe(4);
  });
});

describe("toggleReactionSummary", () => {
  it("adds, increments and removes the viewer's reaction", () => {
    const added = toggleReactionSummary([], "🔥", true);
    expect(added).toEqual([{ reaction: "🔥", count: 1, viewer_reacted: true }]);

    const others = [{ reaction: "🔥", count: 2, viewer_reacted: false }];
    expect(toggleReactionSummary(others, "🔥", true)[0]).toEqual({
      reaction: "🔥",
      count: 3,
      viewer_reacted: true,
    });

    expect(toggleReactionSummary(added, "🔥", false)).toEqual([]);
    // Removing a reaction the viewer never made is a no-op.
    expect(toggleReactionSummary(others, "🔥", false)).toBe(others);
  });
});

describe("findDirectConversation", () => {
  it("matches 1:1 counterparts only", () => {
    const group = makeConversation({ conversation_id: "g", is_group: true, counterparty: BOB });
    const direct = makeConversation({ conversation_id: "d", counterparty: BOB });
    expect(findDirectConversation({ g: group }, BOB.fid)).toBeNull();
    expect(findDirectConversation({ g: group, d: direct }, BOB.fid)?.conversation_id).toBe("d");
  });
});

describe("useMessageStore thread pages", () => {
  beforeEach(() => useMessageStore.getState().reset());

  const page = (
    ids: string[],
    startMinute: number,
    nextCursor: string | null = null,
    newerCursor: string | null = null,
  ) => ({
    items: ids.map((id, index) =>
      makeMessage({ message_id: id, sent_at: BASE_TIME + (startMinute - index) * MINUTE }),
    ),
    next_cursor: nextCursor,
    next_newer_cursor: newerCursor,
  });

  it("stamps syncedAt on a latest-page load but not on a websocket merge", () => {
    const store = useMessageStore.getState();
    store.mergeLatest("c1", page(["m0"], 0).items);
    expect(useMessageStore.getState().threads.c1?.syncedAt ?? null).toBeNull();
    store.setThreadPage("c1", page(["m2", "m1"], 2), "replace");
    const syncedAt = useMessageStore.getState().threads.c1.syncedAt;
    expect(syncedAt).not.toBeNull();
    store.mergeLatest("c1", page(["m3"], 3).items);
    expect(useMessageStore.getState().threads.c1.syncedAt).toBe(syncedAt);
  });

  it("markThreadSynced skips detached and unloaded threads", () => {
    const store = useMessageStore.getState();
    store.markThreadSynced("missing", 5);
    expect(useMessageStore.getState().threads.missing).toBeUndefined();
    store.setThreadPage("c1", page(["m10"], 100), "replace");
    store.markThreadSynced("c1", 5);
    expect(useMessageStore.getState().threads.c1.syncedAt).toBe(5);
    store.setThreadPage("c1", page(["m2"], 2, "older", "newer"), "anchor");
    store.markThreadSynced("c1", 9);
    expect(useMessageStore.getState().threads.c1.syncedAt).toBeNull();
  });

  it("replace keeps pending optimistic messages", () => {
    const store = useMessageStore.getState();
    store.upsertMessage("c1", makeMessage({ message_id: "local", sent_at: BASE_TIME + 99 * MINUTE, send_state: "failed" }));
    store.setThreadPage("c1", page(["m3", "m2"], 10, "cur"), "replace");

    const thread = useMessageStore.getState().threads.c1;
    expect(thread.messages.map((m) => m.message_id)).toEqual(["local", "m3", "m2"]);
    expect(thread.hasOlder).toBe(true);
    expect(thread.isDetached).toBe(false);
  });

  it("detaches when an anchor page doesn't touch the loaded window", () => {
    const store = useMessageStore.getState();
    store.setThreadPage("c1", page(["m10", "m9"], 100), "replace");
    store.setThreadPage("c1", page(["m2", "m1"], 2, "older", "newer"), "anchor");

    const thread = useMessageStore.getState().threads.c1;
    expect(thread.isDetached).toBe(true);
    expect(thread.messages.map((m) => m.message_id)).toEqual(["m2", "m1"]);

    // Live messages must not append to a detached window.
    store.mergeLatest("c1", page(["m11"], 101).items);
    expect(useMessageStore.getState().threads.c1.messages).toHaveLength(2);
  });

  it("merges a contiguous anchor page", () => {
    const store = useMessageStore.getState();
    store.setThreadPage("c1", page(["m10", "m9"], 10), "replace");
    store.setThreadPage("c1", page(["m9", "m8", "m7"], 9), "anchor");

    const thread = useMessageStore.getState().threads.c1;
    expect(thread.isDetached).toBe(false);
    expect(thread.messages.map((m) => m.message_id)).toEqual(["m10", "m9", "m8", "m7"]);
  });

  it("applies and reverts reactions", () => {
    const store = useMessageStore.getState();
    store.setThreadPage("c1", page(["m1"], 1), "replace");
    store.applyReaction("c1", "m1", "👍", true);
    expect(useMessageStore.getState().threads.c1.messages[0].reactions).toEqual([
      { reaction: "👍", count: 1, viewer_reacted: true },
    ]);
    store.applyReaction("c1", "m1", "👍", false);
    expect(useMessageStore.getState().threads.c1.messages[0].reactions).toEqual([]);
  });

  it("moves a draft thread to its real id", () => {
    const store = useMessageStore.getState();
    store.upsertMessage("draft:3", makeMessage({ message_id: "local", send_state: "sending" }));
    store.adoptDraftThread("draft:3", "c9");
    const { threads } = useMessageStore.getState();
    expect(threads["draft:3"]).toBeUndefined();
    expect(threads.c9.messages[0].message_id).toBe("local");
  });
});

describe("applyInboxPage", () => {
  const NOW = BASE_TIME + 10 * MINUTE;
  const response = (ids: string[], nextCursor: string | null): InboxResponse => ({
    items: ids.map((id) => makeConversation({ conversation_id: id })),
    next_cursor: nextCursor,
    requests_count: 0,
    has_unread_requests: false,
    has_archived: false,
  });
  const loaded: InboxSlice = {
    ids: ["a", "b", "c", "d", "e"],
    cursor: "page-3",
    hasMore: true,
    loadedAt: BASE_TIME,
  };

  it("merge upserts page one, reorders it to the top and keeps the loaded tail and cursor", () => {
    const next = applyInboxPage(loaded, response(["d", "new", "a"], "page-2"), "merge", NOW);
    expect(next.ids).toEqual(["d", "new", "a", "b", "c", "e"]);
    expect(next.cursor).toBe("page-3");
    expect(next.hasMore).toBe(true);
    expect(next.loadedAt).toBe(NOW);
  });

  it("merge with the whole inbox on one page replaces (drops removed rows)", () => {
    const next = applyInboxPage(loaded, response(["b", "a"], null), "merge", NOW);
    expect(next).toEqual({ ids: ["b", "a"], cursor: null, hasMore: false, loadedAt: NOW });
  });

  it("merge into an empty slice behaves like replace", () => {
    const empty: InboxSlice = { ids: [], cursor: null, hasMore: false, loadedAt: null };
    const next = applyInboxPage(empty, response(["a"], "page-2"), "merge", NOW);
    expect(next).toEqual({ ids: ["a"], cursor: "page-2", hasMore: true, loadedAt: NOW });
  });

  it("replace drops the tail and takes the page cursor", () => {
    const next = applyInboxPage(loaded, response(["x", "a"], "page-2"), "replace", NOW);
    expect(next).toEqual({ ids: ["x", "a"], cursor: "page-2", hasMore: true, loadedAt: NOW });
  });

  it("append adds unseen ids at the end and advances the cursor", () => {
    const next = applyInboxPage(loaded, response(["e", "f"], null), "append", NOW);
    expect(next.ids).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(next.cursor).toBeNull();
    expect(next.hasMore).toBe(false);
  });
});

describe("useMessageStore inbox", () => {
  beforeEach(() => useMessageStore.getState().reset());

  it("a merged poll keeps loaded pages; removeFromInbox recomputes the badge", () => {
    const store = useMessageStore.getState();
    const conversations = (ids: string[]) =>
      ids.map((id) => makeConversation({ conversation_id: id, unread_count: 1 }));
    store.setInboxPage(
      "default",
      { items: conversations(["a", "b"]), next_cursor: "p2", requests_count: 0, has_unread_requests: false, has_archived: false },
      "replace",
    );
    store.setInboxPage(
      "default",
      { items: conversations(["c", "d"]), next_cursor: "p3", requests_count: 0, has_unread_requests: false, has_archived: false },
      "append",
    );
    store.setInboxPage(
      "default",
      { items: conversations(["c", "a"]), next_cursor: "p2", requests_count: 0, has_unread_requests: false, has_archived: false },
      "merge",
    );
    let state = useMessageStore.getState();
    expect(state.inbox.default.ids).toEqual(["c", "a", "b", "d"]);
    expect(state.inbox.default.cursor).toBe("p3");
    expect(state.unreadTotal).toBe(4);

    store.removeFromInbox("default", "b");
    state = useMessageStore.getState();
    expect(state.inbox.default.ids).toEqual(["c", "a", "d"]);
    expect(state.unreadTotal).toBe(3);
  });
});
