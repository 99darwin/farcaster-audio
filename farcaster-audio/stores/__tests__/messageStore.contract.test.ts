import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  applyAnchorPage,
  canSeedFromHit,
  EMPTY_THREAD,
  mergeSendEcho,
  resolveThreadKey,
  searchHitToPage,
  useMessageStore,
  type ThreadState,
} from "@/stores/messageStore";
import {
  BASE_TIME,
  makeConversation,
  makeMessage,
} from "@/components/messages/__fixtures__/messages";
import type { Message, MessageSearchHit, MessagesPage } from "@/types/messages";

const MINUTE = 60_000;

const at = (id: string, minute: number): Message =>
  makeMessage({ message_id: id, sent_at: BASE_TIME + minute * MINUTE });

const page = (
  items: Message[],
  olderCursor: string | null = null,
  newerCursor: string | null = null,
): MessagesPage => ({ items, next_cursor: olderCursor, next_newer_cursor: newerCursor });

const loadedThread = (
  messages: Message[],
  olderCursor: string | null,
  newerCursor: string | null,
): ThreadState => ({
  ...EMPTY_THREAD,
  messages,
  olderCursor,
  hasOlder: olderCursor !== null,
  newerCursor,
  hasNewer: newerCursor !== null,
  isDetached: newerCursor !== null,
  isLoaded: true,
});

const hit = (overrides: Partial<MessageSearchHit> = {}): MessageSearchHit => ({
  message: at("hit", 5),
  conversation: makeConversation(),
  highlights: [],
  before: [at("b1", 4), at("b2", 3)],
  after: [at("a2", 7), at("a1", 6)],
  ...overrides,
});

describe("applyAnchorPage", () => {
  it("joins only on a shared id, keeping the live tail attached", () => {
    const current = loadedThread([at("m10", 10), at("m9", 9)], "old-9", null);
    const next = applyAnchorPage(current, page([at("m9", 9), at("m8", 8)], "old-8", "new-9"));
    expect(next.messages.map((m) => m.message_id)).toEqual(["m10", "m9", "m8"]);
    expect(next.olderCursor).toBe("old-8");
    // The loaded window already reached the live end; the page's newer
    // cursor must not detach it.
    expect(next.isDetached).toBe(false);
  });

  it("treats time-adjacent pages without a shared id as a gap", () => {
    const current = loadedThread([at("m10", 10), at("m9", 9)], "old-9", null);
    const next = applyAnchorPage(current, page([at("m8", 8)], "old-8", "new-8"));
    expect(next.messages.map((m) => m.message_id)).toEqual(["m8"]);
    expect(next.isDetached).toBe(true);
    expect(next.newerCursor).toBe("new-8");
  });

  it("extends a detached window forward when the page reaches newer", () => {
    const current = loadedThread([at("m5", 5), at("m4", 4)], "old-4", "new-5");
    const next = applyAnchorPage(current, page([at("m6", 6), at("m5", 5)], "old-5", null));
    expect(next.messages.map((m) => m.message_id)).toEqual(["m6", "m5", "m4"]);
    expect(next.olderCursor).toBe("old-4");
    expect(next.newerCursor).toBeNull();
    expect(next.isDetached).toBe(false);
  });
});

describe("search seeds", () => {
  it("renders [...after, message, ...before] with the hit's cursors", () => {
    const seeded = searchHitToPage(hit({ thread_cursor: "older", thread_newer_cursor: "newer" }));
    expect(seeded.items.map((m) => m.message_id)).toEqual(["a2", "a1", "hit", "b1", "b2"]);
    expect(seeded.next_cursor).toBe("older");
    expect(seeded.next_newer_cursor).toBe("newer");
  });

  it("only seeds hits that carry cursor fields", () => {
    expect(canSeedFromHit(hit())).toBe(false);
    expect(canSeedFromHit(hit({ thread_cursor: null, thread_newer_cursor: null }))).toBe(true);
  });
});

describe("mergeSendEcho", () => {
  it("keeps the optimistic reply and metadata when the echo omits them", () => {
    const quote = { message_id: "q", sender: at("q", 0).sender, text: "q", is_deleted: false };
    const optimistic = { ...at("s", 1), in_reply_to: quote, send_state: "sending" as const };
    const echo = { ...at("s", 1), text: "server" };
    const merged = mergeSendEcho(optimistic, echo);
    expect(merged.in_reply_to).toEqual(quote);
    expect(merged.text).toBe("server");
    expect(merged.send_state).toBeUndefined();
  });

  it("keeps the optimistic quote when the echo's quote is a fid-0 placeholder", () => {
    const quote = { message_id: "q", sender: at("q", 0).sender, text: "parent", is_deleted: false };
    const placeholder = {
      message_id: "q",
      sender: { ...at("q", 0).sender, fid: 0, display_name: "" },
      text: "",
      is_deleted: false,
    };
    const optimistic = { ...at("s", 1), in_reply_to: quote, send_state: "sending" as const };
    const merged = mergeSendEcho(optimistic, { ...at("s", 1), in_reply_to: placeholder });
    expect(merged.in_reply_to).toEqual(quote);
  });

  it("takes a fully hydrated echo quote over the optimistic one", () => {
    const local = { message_id: "q", sender: at("q", 0).sender, text: "local", is_deleted: false };
    const server = { ...local, text: "server" };
    const optimistic = { ...at("s", 1), in_reply_to: local, send_state: "sending" as const };
    const merged = mergeSendEcho(optimistic, { ...at("s", 1), in_reply_to: server });
    expect(merged.in_reply_to).toEqual(server);
  });

  it("confirmSentMessage stores the local quote over a placeholder", () => {
    useMessageStore.getState().reset();
    const quote = { message_id: "q", sender: at("q", 0).sender, text: "parent", is_deleted: false };
    const store = useMessageStore.getState();
    store.upsertMessage("c1", { ...at("s", 1), in_reply_to: quote, send_state: "sending" });
    store.confirmSentMessage("c1", {
      ...at("s", 1),
      in_reply_to: {
        message_id: "q",
        sender: { ...quote.sender, fid: 0, display_name: "" },
        text: "",
        is_deleted: false,
      },
    });
    expect(useMessageStore.getState().threads.c1.messages[0].in_reply_to).toEqual(quote);
  });
});

describe("useMessageStore contract actions", () => {
  beforeEach(() => useMessageStore.getState().reset());

  it("newer mode merges forward and re-attaches at the live end", () => {
    const store = useMessageStore.getState();
    store.setThreadPage("c1", page([at("m5", 5)], "old", "new-5"), "anchor");
    expect(useMessageStore.getState().threads.c1.isDetached).toBe(true);
    store.setThreadPage("c1", page([at("m7", 7), at("m6", 6)], null, null), "newer");
    const thread = useMessageStore.getState().threads.c1;
    expect(thread.messages.map((m) => m.message_id)).toEqual(["m7", "m6", "m5"]);
    expect(thread.olderCursor).toBe("old");
    expect(thread.isDetached).toBe(false);
  });

  it("markSendFailed only flips rows that are still sending", () => {
    const store = useMessageStore.getState();
    store.upsertMessage("c1", { ...at("s", 1), send_state: "sending" });
    store.confirmSentMessage("c1", at("s", 1));
    store.markSendFailed("c1", "s");
    expect(useMessageStore.getState().threads.c1.messages[0].send_state).toBeUndefined();

    store.upsertMessage("c1", { ...at("t", 2), send_state: "sending" });
    store.markSendFailed("c1", "t");
    expect(useMessageStore.getState().threads.c1.messages[0].send_state).toBe("failed");
  });

  it("applyPeerRead moves only the peer marker", () => {
    const store = useMessageStore.getState();
    store.upsertConversation(
      makeConversation({ unread_count: 3, manually_marked_unread: true, peer_last_read_at: 0 }),
    );
    store.applyPeerRead("c1", BASE_TIME);
    const conversation = useMessageStore.getState().conversations.c1;
    expect(conversation.peer_last_read_at).toBe(BASE_TIME);
    expect(conversation.unread_count).toBe(3);
    expect(conversation.manually_marked_unread).toBe(true);
  });

  it("aliases a draft key to its conversation, even with no draft thread", () => {
    useMessageStore.getState().adoptDraftThread("draft:7", "c7");
    expect(resolveThreadKey("draft:7")).toBe("c7");
    expect(resolveThreadKey("c1")).toBe("c1");
  });

  it("hands a stashed search seed over exactly once", () => {
    const store = useMessageStore.getState();
    const seed = hit();
    store.stashSearchSeed(seed);
    expect(store.takeSearchSeed("hit")).toBe(seed);
    expect(useMessageStore.getState().takeSearchSeed("hit")).toBeNull();
  });

  it("remembers scroll offsets per thread and clears them on reset", () => {
    const store = useMessageStore.getState();
    store.setScrollOffset("c1", 420);
    expect(useMessageStore.getState().scrollOffsets.c1).toBe(420);
    store.reset();
    expect(useMessageStore.getState().scrollOffsets).toEqual({});
  });
});
