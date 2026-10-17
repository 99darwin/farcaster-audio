/**
 * Messaging store: optimistic sends + retry, the draft -> real conversation
 * move, optimistic reactions with revert, unread totals, websocket ingestion
 * and detached jump-to-message pages. The API layer is mocked.
 */

jest.mock("@/lib/api/messages", () => {
  const actual = jest.requireActual("@/lib/api/messages");
  return {
    ...actual,
    getInbox: jest.fn(),
    getConversation: jest.fn(),
    getMessages: jest.fn(),
    getRecentMessages: jest.fn(),
    getConversationWith: jest.fn(),
    acceptConversation: jest.fn(),
    declineConversation: jest.fn(),
    sendMessage: jest.fn(),
    addReaction: jest.fn(),
    removeReaction: jest.fn(),
    deleteMessage: jest.fn(),
    markConversationRead: jest.fn(),
    markConversationUnread: jest.fn(),
  };
});
jest.mock("@/lib/auth/session", () => ({ getJwt: jest.fn(() => null) }));
jest.mock("@/lib/auth/authRefresh", () => ({ refreshSession: jest.fn() }));

import * as api from "@/lib/api/messages";
import { ApiFetchError } from "@/lib/api/client";
import type { Conversation, InboxResponse, Message, MessageSearchHit, MessagesPage } from "@/lib/api/messages.types";
import { computeUnreadTotal, draftConversationKey, useMessageStore } from "@/lib/stores/messageStore";
import { ALICE, BASE_TIME, BOB, MINUTE, makeConversation, makeMessage } from "@/lib/messages/__tests__/fixtures";

const mocked = api as jest.Mocked<typeof api>;
const store = () => useMessageStore.getState();

function inboxPage(items: Conversation[], overrides: Partial<InboxResponse> = {}): InboxResponse {
  return {
    items,
    next_cursor: null,
    requests_count: 0,
    has_unread_requests: false,
    has_archived: false,
    ...overrides,
  };
}

function page(
  items: Message[],
  next_cursor: string | null = null,
  next_newer_cursor: string | null = null,
): MessagesPage {
  return { items, next_cursor, next_newer_cursor };
}

beforeEach(() => {
  jest.resetAllMocks();
  store().reset();
  store().setViewer(ALICE);
});

describe("computeUnreadTotal", () => {
  it("sums unmuted unread counts and counts manual unread as one", () => {
    const conversations = {
      a: makeConversation({ conversation_id: "a", unread_count: 3 }),
      b: makeConversation({ conversation_id: "b", unread_count: 5, muted: true }),
      c: makeConversation({ conversation_id: "c", manually_marked_unread: true }),
    };
    expect(computeUnreadTotal(["a", "b", "c", "missing"], conversations)).toBe(4);
  });
});

describe("inbox", () => {
  it("loads conversations, request counts and the unread total", async () => {
    mocked.getInbox.mockResolvedValue(
      inboxPage([makeConversation({ unread_count: 2 })], { requests_count: 4, has_unread_requests: true }),
    );
    await store().loadInbox("default");
    expect(store().inbox.default).toMatchObject({ ids: ["c1"], status: "ready", hasMore: false });
    expect(store()).toMatchObject({
      availability: "available",
      requestsCount: 4,
      hasUnreadRequests: true,
      unreadTotal: 2,
    });
  });

  it("flags signer and disabled errors", async () => {
    mocked.getInbox.mockRejectedValueOnce(new ApiFetchError(403, api.MESSAGING_TOKEN_EXPIRED));
    await store().loadInbox("default");
    expect(store().availability).toBe("token_required");

    // The 503 "can't decrypt" is transient, not a gate.
    mocked.getInbox.mockRejectedValueOnce(new ApiFetchError(503, api.MESSAGING_TOKEN_UNAVAILABLE));
    store().setAvailability("unknown");
    await store().loadInbox("default");
    expect(store().availability).toBe("unknown");

    mocked.getInbox.mockRejectedValueOnce(new ApiFetchError(404, api.MESSAGING_DISABLED));
    await store().loadInbox("default");
    expect(store().availability).toBe("disabled");
  });

  it("does not treat a per-conversation 404 as the feature being off", async () => {
    mocked.getMessages.mockRejectedValueOnce(new ApiFetchError(404, "conversation_not_found"));
    await store().loadLatest("gone");
    expect(store().availability).toBe("unknown");
    expect(store().threads.gone).toMatchObject({ status: "error", isNotFound: true, error: null });
    expect(store().missingConversations.gone).toBe(true);

    mocked.getConversation.mockRejectedValueOnce(new ApiFetchError(404, "not_found"));
    await expect(store().ensureConversation("gone-2")).resolves.toBeNull();
    expect(store().availability).toBe("unknown");
    expect(store().missingConversations["gone-2"]).toBe(true);
  });

  it("keeps the paginated tail when page 1 refreshes", async () => {
    const at = (id: string, minutesAgo: number) =>
      makeConversation({
        conversation_id: id,
        last_message: makeMessage({ message_id: `${id}-m`, conversation_id: id, sent_at: BASE_TIME - minutesAgo * MINUTE }),
      });
    mocked.getInbox.mockResolvedValueOnce(inboxPage([at("a", 1), at("b", 2)], { next_cursor: "p2" }));
    await store().loadInbox("default");
    mocked.getInbox.mockResolvedValueOnce(inboxPage([at("c", 3), at("d", 4)], { next_cursor: "p3" }));
    await store().loadMoreInbox("default");
    expect(store().inbox.default.ids).toEqual(["a", "b", "c", "d"]);

    // New activity in "d" moves it to the top; page 1 is now [d, a].
    mocked.getInbox.mockResolvedValueOnce(inboxPage([at("d", 0), at("a", 1)], { next_cursor: "p2-new" }));
    await store().loadInbox("default");
    expect(store().inbox.default).toMatchObject({ ids: ["d", "a", "b", "c"], cursor: "p3", hasMore: true });
  });

  it("drops conversations that left page 1's range on refresh", async () => {
    mocked.getInbox.mockResolvedValueOnce(
      inboxPage([makeConversation({ conversation_id: "a", created_at: 3 }), makeConversation({ conversation_id: "b", created_at: 2 })], {
        next_cursor: "p2",
      }),
    );
    await store().loadInbox("default");
    mocked.getInbox.mockResolvedValueOnce(inboxPage([makeConversation({ conversation_id: "a", created_at: 3 })]));
    await store().loadInbox("default");
    expect(store().inbox.default).toMatchObject({ ids: ["a"], hasMore: false });
  });

  it("resets everything when the viewer changes", async () => {
    mocked.getInbox.mockResolvedValue(inboxPage([makeConversation()]));
    await store().loadInbox("default");
    store().setViewer(BOB);
    expect(store().inbox.default.ids).toEqual([]);
    expect(store().viewer).toEqual(BOB);
  });
});

describe("sending", () => {
  beforeEach(async () => {
    mocked.getInbox.mockResolvedValue(inboxPage([makeConversation()]));
    await store().loadInbox("default");
    mocked.getMessages.mockResolvedValue(page([makeMessage({ message_id: "old", sent_at: BASE_TIME - MINUTE })]));
    await store().loadLatest("c1");
  });

  it("shows the message optimistically, then confirms it", async () => {
    let resolve!: (value: { message: Message }) => void;
    mocked.sendMessage.mockReturnValue(new Promise((r) => (resolve = r)));
    store().setDraft("c1", " hi ");

    const pending = store().sendMessage({ conversationId: "c1", text: " hi ", replyTo: null });
    const optimistic = store().threads.c1.messages.at(-1)!;
    expect(optimistic).toMatchObject({ text: "hi", send_state: "sending", sender: ALICE });
    expect(store().drafts.c1).toBe("");

    const request = mocked.sendMessage.mock.calls[0][0];
    expect(request).toMatchObject({ conversation_id: "c1", recipient_fids: [], text: "hi", in_reply_to_id: null });
    expect(request).not.toHaveProperty("process_metadata");

    resolve({ message: makeMessage({ message_id: request.message_id, sender: ALICE, text: "hi", sent_at: BASE_TIME }) });
    await expect(pending).resolves.toMatchObject({ ok: true, conversationId: "c1" });
    const messages = store().threads.c1.messages;
    expect(messages).toHaveLength(2);
    expect(messages.at(-1)!.send_state).toBeUndefined();
    expect(store().conversations.c1.last_message?.message_id).toBe(request.message_id);
    expect(store().pendingSends).toEqual({});
  });

  it("sends process_metadata=false only when the preview was dismissed", async () => {
    mocked.sendMessage.mockRejectedValue(new Error("offline"));
    await store().sendMessage({ conversationId: "c1", text: "x", replyTo: null, processMetadata: false });
    expect(mocked.sendMessage.mock.calls[0][0].process_metadata).toBe(false);
  });

  it("marks failures and retries with the same message id", async () => {
    mocked.sendMessage.mockRejectedValueOnce(new Error("offline"));
    const result = await store().sendMessage({ conversationId: "c1", text: "retry me", replyTo: null });
    expect(result.ok).toBe(false);
    expect(store().threads.c1.messages.at(-1)!.send_state).toBe("failed");

    const firstId = mocked.sendMessage.mock.calls[0][0].message_id;
    mocked.sendMessage.mockResolvedValueOnce({
      message: makeMessage({ message_id: firstId, sender: ALICE, text: "retry me", sent_at: BASE_TIME }),
    });
    await expect(store().retrySend("c1", firstId)).resolves.toMatchObject({ ok: true });
    expect(mocked.sendMessage.mock.calls[1][0].message_id).toBe(firstId);
    expect(store().threads.c1.messages.at(-1)!.send_state).toBeUndefined();
  });

  it("discards a failed message", async () => {
    mocked.sendMessage.mockRejectedValueOnce(new Error("offline"));
    const { messageId } = await store().sendMessage({ conversationId: "c1", text: "nope", replyTo: null });
    store().discardFailed("c1", messageId);
    expect(store().threads.c1.messages.map((m) => m.message_id)).toEqual(["old"]);
    expect(store().pendingSends).toEqual({});
  });

  it("keeps the optimistic reply quote when the echo omits it", async () => {
    const parent = store().threads.c1.messages[0];
    mocked.sendMessage.mockImplementation(async (request) => ({
      message: makeMessage({ message_id: request.message_id, sender: ALICE, text: "re", in_reply_to: null }),
    }));
    await store().sendMessage({ conversationId: "c1", text: "re", replyTo: parent });
    expect(store().threads.c1.messages.at(-1)!.in_reply_to).toMatchObject({ message_id: "old" });
  });

  it("does not mark a message failed once an echo confirmed it", async () => {
    let reject!: (error: Error) => void;
    mocked.sendMessage.mockReturnValue(new Promise((_, r) => (reject = r)));
    const pending = store().sendMessage({ conversationId: "c1", text: "dup", replyTo: null });
    const { message_id } = mocked.sendMessage.mock.calls[0][0];
    // The websocket delivers the server copy before the PUT fails.
    store().ingestEvent({
      type: "message",
      conversation_id: "c1",
      message: makeMessage({ message_id, sender: ALICE, text: "dup", sent_at: BASE_TIME + MINUTE }),
    });
    reject(new Error("timeout"));
    await pending;
    expect(store().threads.c1.messages.at(-1)!.send_state).toBeUndefined();
  });

  it("never stamps an optimistic message before the newest loaded one", async () => {
    jest.spyOn(Date, "now").mockReturnValue(BASE_TIME - 10 * MINUTE);
    mocked.sendMessage.mockReturnValue(new Promise(() => {}));
    void store().sendMessage({ conversationId: "c1", text: "skewed clock", replyTo: null });
    const messages = store().threads.c1.messages;
    expect(messages.at(-1)!.text).toBe("skewed clock");
    expect(messages.at(-1)!.sent_at).toBe(BASE_TIME - MINUTE + 1);
    jest.restoreAllMocks();
  });

  it("refuses empty text", async () => {
    await expect(store().sendMessage({ conversationId: "c1", text: "   ", replyTo: null })).resolves.toMatchObject({
      ok: false,
    });
    expect(mocked.sendMessage).not.toHaveBeenCalled();
  });
});

describe("first message to a new peer", () => {
  it("moves the draft thread to the real conversation id", async () => {
    mocked.sendMessage.mockImplementation(async (request) => ({
      message: makeMessage({
        message_id: request.message_id,
        conversation_id: "new-convo",
        sender: ALICE,
        text: request.text,
      }),
    }));
    mocked.getConversation.mockResolvedValue(makeConversation({ conversation_id: "new-convo" }));

    const result = await store().sendMessage({ conversationId: null, recipientFid: BOB.fid, text: "hey", replyTo: null });
    expect(result).toMatchObject({ ok: true, conversationId: "new-convo" });
    expect(mocked.sendMessage.mock.calls[0][0]).toMatchObject({ conversation_id: null, recipient_fids: [BOB.fid] });
    expect(store().threads[draftConversationKey(BOB.fid)]).toBeUndefined();
    expect(store().threads["new-convo"].messages.map((m) => m.text)).toEqual(["hey"]);
    await Promise.resolve();
    expect(mocked.getConversation).toHaveBeenCalledWith("new-convo");
  });

  it("serializes concurrent draft sends behind the conversation-creating one", async () => {
    const resolvers: Array<() => void> = [];
    // Distinct server timestamps in send order (equal ones would tie-break on random ids).
    let sendIndex = 0;
    mocked.sendMessage.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          sendIndex += 1;
          const sentAt = BASE_TIME + sendIndex;
          resolvers.push(() =>
            resolve({
              message: makeMessage({
                message_id: request.message_id,
                conversation_id: "new-convo",
                sender: ALICE,
                text: request.text,
                sent_at: sentAt,
              }),
            }),
          );
        }),
    );
    mocked.getConversation.mockResolvedValue(makeConversation({ conversation_id: "new-convo" }));

    const first = store().sendMessage({ conversationId: null, recipientFid: BOB.fid, text: "one", replyTo: null });
    const second = store().sendMessage({ conversationId: null, recipientFid: BOB.fid, text: "two", replyTo: null });
    expect(store().threads[draftConversationKey(BOB.fid)].messages.map((m) => m.text)).toEqual(["one", "two"]);
    await Promise.resolve();
    expect(mocked.sendMessage).toHaveBeenCalledTimes(1);

    resolvers[0]();
    await expect(first).resolves.toMatchObject({ ok: true, conversationId: "new-convo" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocked.sendMessage).toHaveBeenCalledTimes(2);
    expect(mocked.sendMessage.mock.calls[1][0]).toMatchObject({ conversation_id: "new-convo", recipient_fids: [] });

    resolvers[1]();
    await expect(second).resolves.toMatchObject({ ok: true, conversationId: "new-convo" });
    expect(store().threads["new-convo"].messages.map((m) => [m.text, m.send_state])).toEqual([
      ["one", undefined],
      ["two", undefined],
    ]);

    // Later sends from the same draft go straight to the real id.
    resolvers.length = 0;
    const third = store().sendMessage({ conversationId: null, recipientFid: BOB.fid, text: "three", replyTo: null });
    expect(mocked.sendMessage.mock.calls[2][0]).toMatchObject({ conversation_id: "new-convo" });
    resolvers[0]();
    await third;
  });
});

describe("direct conversations + requests", () => {
  it("finds an existing 1:1 and returns null when there is none", async () => {
    mocked.getConversationWith.mockResolvedValueOnce(makeConversation({ conversation_id: "dm" }));
    await expect(store().findDirectConversation(2)).resolves.toMatchObject({ conversation_id: "dm" });
    expect(store().conversations.dm).toBeDefined();
    mocked.getConversationWith.mockRejectedValueOnce(new ApiFetchError(404, "conversation_not_found"));
    await expect(store().findDirectConversation(3)).resolves.toBeNull();
    mocked.getConversationWith.mockRejectedValueOnce(new ApiFetchError(400, "invalid_recipient"));
    await expect(store().findDirectConversation(1)).rejects.toThrow();
  });

  it("accepts a request, then refetches both inboxes", async () => {
    mocked.getInbox.mockResolvedValueOnce(inboxPage([makeConversation({ category: "request" })], { requests_count: 1 }));
    await store().loadInbox("request");
    mocked.acceptConversation.mockResolvedValue(undefined);
    mocked.getInbox.mockResolvedValue(inboxPage([]));
    await store().acceptRequest("c1");
    expect(mocked.acceptConversation).toHaveBeenCalledWith("c1");
    expect(mocked.getInbox).toHaveBeenCalledWith({ category: "default" });
    expect(mocked.getInbox).toHaveBeenCalledWith({ category: "request" });
  });

  it("restores the request row when decline fails", async () => {
    mocked.getInbox.mockResolvedValueOnce(inboxPage([makeConversation({ category: "request" })], { requests_count: 1 }));
    await store().loadInbox("request");
    let reject!: (error: Error) => void;
    mocked.declineConversation.mockReturnValue(new Promise((_, r) => (reject = r)));
    const pending = store().declineRequest("c1");
    expect(store().inbox.request.ids).toEqual([]);
    reject(new Error("nope"));
    await expect(pending).rejects.toThrow("nope");
    expect(store().inbox.request.ids).toEqual(["c1"]);
    expect(store().requestsCount).toBe(1);
  });
});

describe("reactions", () => {
  beforeEach(async () => {
    mocked.getMessages.mockResolvedValue(page([makeMessage({ message_id: "m1" })]));
    await store().loadLatest("c1");
  });

  it("applies optimistically and keeps the result on success", async () => {
    mocked.addReaction.mockResolvedValue(undefined);
    await store().toggleReaction("c1", "m1", "🔥");
    expect(mocked.addReaction).toHaveBeenCalledWith({ conversation_id: "c1", message_id: "m1", reaction: "🔥" });
    expect(store().threads.c1.messages[0].reactions).toEqual([{ reaction: "🔥", count: 1, viewer_reacted: true }]);

    mocked.removeReaction.mockResolvedValue(undefined);
    await store().toggleReaction("c1", "m1", "🔥");
    expect(mocked.removeReaction).toHaveBeenCalled();
    expect(store().threads.c1.messages[0].reactions).toEqual([]);
  });

  it("reverts and rethrows on failure", async () => {
    mocked.addReaction.mockRejectedValue(new Error("nope"));
    await expect(store().toggleReaction("c1", "m1", "🔥")).rejects.toThrow("nope");
    expect(store().threads.c1.messages[0].reactions).toEqual([]);
  });

  it("restores the exact snapshot when a concurrent update landed", async () => {
    let reject!: (error: Error) => void;
    mocked.addReaction.mockReturnValue(new Promise((_, r) => (reject = r)));
    const pending = store().toggleReaction("c1", "m1", "🔥");
    // A poll lands with someone else's reaction already counted (and ours).
    mocked.getRecentMessages.mockResolvedValueOnce(
      page([makeMessage({ message_id: "m1", reactions: [{ reaction: "🔥", count: 2, viewer_reacted: true }] })]),
    );
    await store().pollRecent("c1");
    reject(new Error("nope"));
    await expect(pending).rejects.toThrow();
    // A relative re-toggle would leave {count: 1, viewer_reacted: false}.
    expect(store().threads.c1.messages[0].reactions).toEqual([]);
  });

  it("reverts a failed delete", async () => {
    mocked.deleteMessage.mockRejectedValue(new Error("nope"));
    await expect(store().deleteMessage("c1", "m1")).rejects.toThrow("nope");
    expect(store().threads.c1.messages[0].is_deleted).toBe(false);
  });
});

describe("read state", () => {
  beforeEach(async () => {
    mocked.getInbox.mockResolvedValue(inboxPage([makeConversation({ unread_count: 3, unread_mentions_count: 1 })]));
    await store().loadInbox("default");
  });

  it("zeroes unread optimistically", async () => {
    mocked.markConversationRead.mockResolvedValue(undefined);
    await store().markRead("c1");
    expect(store().conversations.c1).toMatchObject({ unread_count: 0, unread_mentions_count: 0 });
    expect(store().unreadTotal).toBe(0);
  });

  it("skips a redundant mark-read for the same newest message", async () => {
    mocked.getMessages.mockResolvedValue(page([makeMessage({ message_id: "m1" })]));
    await store().loadLatest("c1");
    mocked.markConversationRead.mockResolvedValue(undefined);
    await store().markRead("c1");
    // A stale inbox poll brings the count back.
    mocked.getInbox.mockResolvedValueOnce(inboxPage([makeConversation({ unread_count: 3 })]));
    await store().loadInbox("default");
    await store().markRead("c1");
    expect(mocked.markConversationRead).toHaveBeenCalledTimes(1);
    expect(store().conversations.c1.unread_count).toBe(0);

    // After marking unread, reading again is a real request.
    mocked.markConversationUnread.mockResolvedValue(undefined);
    await store().markUnread("c1");
    await store().markRead("c1");
    expect(mocked.markConversationRead).toHaveBeenCalledTimes(2);
  });

  it("marks unread and reverts on failure", async () => {
    mocked.markConversationRead.mockResolvedValue(undefined);
    await store().markRead("c1");
    mocked.markConversationUnread.mockRejectedValue(new Error("nope"));
    await expect(store().markUnread("c1")).rejects.toThrow();
    expect(store().conversations.c1.manually_marked_unread).toBe(false);
    expect(store().unreadTotal).toBe(0);
  });
});

describe("ingestEvent", () => {
  beforeEach(async () => {
    mocked.getInbox.mockResolvedValue(
      inboxPage([makeConversation(), makeConversation({ conversation_id: "c2", counterparty: ALICE })]),
    );
    await store().loadInbox("default");
    mocked.getMessages.mockResolvedValue(page([makeMessage({ message_id: "m1" })]));
    await store().loadLatest("c2");
  });

  it("appends to loaded threads, bumps unread and promotes the row", () => {
    const message = makeMessage({ message_id: "m2", conversation_id: "c2", sent_at: BASE_TIME + MINUTE });
    expect(store().ingestEvent({ type: "message", conversation_id: "c2", message })).toBe(false);
    expect(store().threads.c2.messages.map((m) => m.message_id)).toEqual(["m1", "m2"]);
    expect(store().conversations.c2.unread_count).toBe(1);
    expect(store().inbox.default.ids).toEqual(["c2", "c1"]);
    expect(store().unreadTotal).toBe(1);
  });

  it("does not count the viewer's own messages as unread", () => {
    const message = makeMessage({ message_id: "m3", conversation_id: "c2", sender: ALICE, sent_at: BASE_TIME + MINUTE });
    store().ingestEvent({ type: "message", conversation_id: "c2", message });
    expect(store().conversations.c2.unread_count).toBe(0);
  });

  it("asks for an inbox refetch for unknown conversations and inbox events", () => {
    const message = makeMessage({ message_id: "x", conversation_id: "unknown" });
    expect(store().ingestEvent({ type: "message", conversation_id: "unknown", message })).toBe(true);
    expect(store().ingestEvent({ type: "inbox", conversation_id: "c1" })).toBe(true);
    expect(store().ingestEvent({ type: "ping" })).toBe(false);
  });

  it("clears unread on read events", () => {
    const message = makeMessage({ message_id: "m2", conversation_id: "c2", sent_at: BASE_TIME + MINUTE });
    store().ingestEvent({ type: "message", conversation_id: "c2", message });
    store().ingestEvent({ type: "read", conversation_id: "c2", read_by: "viewer" });
    expect(store().conversations.c2.unread_count).toBe(0);
  });

  it("only refreshes the receipt when the peer read", async () => {
    const message = makeMessage({ message_id: "m2", conversation_id: "c2", sent_at: BASE_TIME + MINUTE });
    store().ingestEvent({ type: "message", conversation_id: "c2", message });
    mocked.getConversation.mockResolvedValueOnce(
      makeConversation({ conversation_id: "c2", unread_count: 0, peer_last_read_at: BASE_TIME + MINUTE }),
    );
    store().ingestEvent({ type: "read", conversation_id: "c2", read_by: "peer" });
    expect(store().conversations.c2.unread_count).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(mocked.getConversation).toHaveBeenCalledWith("c2");
    expect(store().conversations.c2).toMatchObject({ unread_count: 1, peer_last_read_at: BASE_TIME + MINUTE });
  });
});

describe("jumpToMessage", () => {
  beforeEach(async () => {
    mocked.getMessages.mockResolvedValueOnce(
      page([makeMessage({ message_id: "m10", sent_at: BASE_TIME }), makeMessage({ message_id: "m11", sent_at: BASE_TIME + 1 })], "cursor-10"),
    );
    await store().loadLatest("c1");
  });

  it("resolves loaded messages without fetching", async () => {
    await expect(store().jumpToMessage("c1", "m11")).resolves.toBe(true);
    expect(mocked.getMessages).toHaveBeenCalledTimes(1);
  });

  it("merges an overlapping anchor page", async () => {
    mocked.getMessages.mockResolvedValueOnce(
      page([makeMessage({ message_id: "m9", sent_at: BASE_TIME - 1 }), makeMessage({ message_id: "m10", sent_at: BASE_TIME })], "cursor-9", "n"),
    );
    await expect(store().jumpToMessage("c1", "m9")).resolves.toBe(true);
    expect(mocked.getMessages).toHaveBeenLastCalledWith("c1", { anchorMessageId: "m9" });
    expect(store().threads.c1.messages.map((m) => m.message_id)).toEqual(["m9", "m10", "m11"]);
    expect(store().threads.c1).toMatchObject({ hasNewer: false, olderCursor: "cursor-9" });
  });

  it("pages forward from a jump to the live end without a reload", async () => {
    mocked.getMessages.mockResolvedValueOnce(
      page([makeMessage({ message_id: "m1", sent_at: BASE_TIME - 60 * MINUTE })], "older-1", "newer-1"),
    );
    await store().jumpToMessage("c1", "m1");
    expect(store().threads.c1).toMatchObject({ hasNewer: true, newerCursor: "newer-1", olderCursor: "older-1" });

    mocked.getMessages.mockResolvedValueOnce(
      page([makeMessage({ message_id: "m5", sent_at: BASE_TIME - 30 * MINUTE }), makeMessage({ message_id: "m2", sent_at: BASE_TIME - 59 * MINUTE })], null, "newer-2"),
    );
    await store().loadNewer("c1");
    expect(mocked.getMessages).toHaveBeenLastCalledWith("c1", { cursor: "newer-1" });
    expect(store().threads.c1).toMatchObject({ hasNewer: true, newerCursor: "newer-2", olderCursor: "older-1" });

    mocked.getRecentMessages.mockResolvedValue(page([]));
    mocked.getMessages.mockResolvedValueOnce(page([makeMessage({ message_id: "m12", sent_at: BASE_TIME + 2 })], null, null));
    await store().loadNewer("c1");
    expect(store().threads.c1).toMatchObject({ hasNewer: false, newerCursor: null, newerWhileDetached: 0 });
    expect(store().threads.c1.messages.map((m) => m.message_id)).toEqual(["m1", "m2", "m5", "m12"]);
    expect(mocked.getRecentMessages).toHaveBeenCalledWith("c1");
  });

  it("seeds a thread from a search hit with its cursors", () => {
    const hit: MessageSearchHit = {
      message: makeMessage({ message_id: "hit", conversation_id: "c9", sent_at: BASE_TIME }),
      conversation: makeConversation({ conversation_id: "c9" }),
      highlights: [],
      after: [makeMessage({ message_id: "a2", conversation_id: "c9", sent_at: BASE_TIME + 2 }), makeMessage({ message_id: "a1", conversation_id: "c9", sent_at: BASE_TIME + 1 })],
      before: [makeMessage({ message_id: "b1", conversation_id: "c9", sent_at: BASE_TIME - 1 })],
      thread_cursor: "older",
      thread_newer_cursor: "newer",
    };
    store().seedFromSearchHit(hit);
    expect(store().threads.c9.messages.map((m) => m.message_id)).toEqual(["b1", "hit", "a1", "a2"]);
    expect(store().threads.c9).toMatchObject({ status: "ready", olderCursor: "older", newerCursor: "newer", hasNewer: true });
    expect(store().conversations.c9).toBeDefined();
    expect(mocked.getMessages).toHaveBeenCalledTimes(1);

    // An old server without cursors leaves the thread for the anchor fallback.
    store().seedFromSearchHit({ ...hit, conversation: makeConversation({ conversation_id: "c8" }), thread_cursor: undefined });
    expect(store().threads.c8).toBeUndefined();
  });

  it("detaches on a non-contiguous page, counts newer messages, then reattaches", async () => {
    mocked.getMessages.mockResolvedValueOnce(page([makeMessage({ message_id: "m1", sent_at: BASE_TIME - 60 * MINUTE })], "cursor-1", "n"));
    await expect(store().jumpToMessage("c1", "m1")).resolves.toBe(true);
    expect(store().threads.c1).toMatchObject({ hasNewer: true, olderCursor: "cursor-1" });
    expect(store().threads.c1.messages.map((m) => m.message_id)).toEqual(["m1"]);

    mocked.getRecentMessages.mockResolvedValueOnce(
      page([makeMessage({ message_id: "m11", sent_at: BASE_TIME + 1 }), makeMessage({ message_id: "m12", sent_at: BASE_TIME + 2 })]),
    );
    await store().pollRecent("c1");
    expect(store().threads.c1.newerWhileDetached).toBe(2);
    expect(store().threads.c1.messages).toHaveLength(1);

    mocked.getMessages.mockResolvedValueOnce(page([makeMessage({ message_id: "m12", sent_at: BASE_TIME + 2 })], "c"));
    await store().loadLatest("c1");
    expect(store().threads.c1).toMatchObject({ hasNewer: false, newerWhileDetached: 0 });
    expect(store().threads.c1.messages.map((m) => m.message_id)).toEqual(["m12"]);
  });

  it("returns false when the anchor page lacks the message", async () => {
    mocked.getMessages.mockResolvedValueOnce(page([]));
    await expect(store().jumpToMessage("c1", "gone")).resolves.toBe(false);
  });
});

describe("upstream_rejected sends", () => {
  beforeEach(async () => {
    mocked.getInbox.mockResolvedValue(inboxPage([makeConversation()]));
    await store().loadInbox("default");
    mocked.getMessages.mockResolvedValue(page([makeMessage({ message_id: "old", sent_at: BASE_TIME - MINUTE })]));
    await store().loadLatest("c1");
  });

  const rejected = (message?: string) => new ApiFetchError(422, api.UPSTREAM_REJECTED, message);

  it("records upstream's reason on the failed bubble and never auto-retries", async () => {
    mocked.sendMessage.mockRejectedValueOnce(rejected("Recipient blocks DMs"));
    const { messageId, ok } = await store().sendMessage({ conversationId: "c1", text: "hey", replyTo: null });
    expect(ok).toBe(false);
    expect(store().threads.c1.messages.at(-1)!.send_state).toBe("failed");
    expect(store().sendErrors[messageId]).toBe("Recipient blocks DMs");
    expect(mocked.sendMessage).toHaveBeenCalledTimes(1);
    // Not an outage: availability and the thread's error stay untouched.
    expect(store().availability).not.toBe("disabled");
    expect(store().threads.c1.error).toBeNull();
  });

  it("falls back to clear copy without a message", async () => {
    mocked.sendMessage.mockRejectedValueOnce(rejected());
    const { messageId } = await store().sendMessage({ conversationId: "c1", text: "hey", replyTo: null });
    expect(store().sendErrors[messageId]).toBe(api.UPSTREAM_REJECTED_FALLBACK_COPY);
  });

  it("leaves no reason for ordinary failures", async () => {
    mocked.sendMessage.mockRejectedValueOnce(new Error("offline"));
    const { messageId } = await store().sendMessage({ conversationId: "c1", text: "hey", replyTo: null });
    expect(store().sendErrors).not.toHaveProperty(messageId);
  });

  it("clears the reason on a successful retry and on discard", async () => {
    mocked.sendMessage.mockRejectedValueOnce(rejected("nope"));
    const first = await store().sendMessage({ conversationId: "c1", text: "a", replyTo: null });
    mocked.sendMessage.mockResolvedValueOnce({
      message: makeMessage({ message_id: first.messageId, sender: ALICE, text: "a", sent_at: BASE_TIME }),
    });
    await store().retrySend("c1", first.messageId);
    expect(store().sendErrors).toEqual({});

    mocked.sendMessage.mockRejectedValueOnce(rejected("nope"));
    const second = await store().sendMessage({ conversationId: "c1", text: "b", replyTo: null });
    expect(store().sendErrors[second.messageId]).toBe("nope");
    store().discardFailed("c1", second.messageId);
    expect(store().sendErrors).toEqual({});
  });
});

describe("invalid_cursor", () => {
  const staleCursor = () => new ApiFetchError(400, api.INVALID_CURSOR);

  it("drops the inbox cursor and reloads from page 1", async () => {
    mocked.getInbox.mockResolvedValueOnce(
      inboxPage([makeConversation({ conversation_id: "a" })], { next_cursor: "stale" }),
    );
    await store().loadInbox("default");
    mocked.getInbox.mockRejectedValueOnce(staleCursor());
    mocked.getInbox.mockResolvedValueOnce(
      inboxPage([makeConversation({ conversation_id: "b" }), makeConversation({ conversation_id: "a" })], {
        next_cursor: "fresh",
      }),
    );
    await store().loadMoreInbox("default");
    expect(mocked.getInbox.mock.calls[2][0]).not.toHaveProperty("cursor", "stale");
    expect(store().inbox.default).toMatchObject({
      ids: ["b", "a"],
      cursor: "fresh",
      status: "ready",
      loadingMore: false,
      error: null,
    });
  });

  it.each(["loadOlder", "loadNewer"] as const)("%s reloads the thread from the start", async (action) => {
    mocked.getInbox.mockResolvedValue(inboxPage([makeConversation()]));
    await store().loadInbox("default");
    mocked.getMessages.mockResolvedValueOnce(page([makeMessage({ message_id: "m1" })], "older"));
    await store().loadLatest("c1");
    if (action === "loadNewer") {
      useMessageStore.setState((state) => ({
        threads: { ...state.threads, c1: { ...state.threads.c1, hasNewer: true, newerCursor: "newer" } },
      }));
    }
    mocked.getMessages.mockRejectedValueOnce(staleCursor());
    mocked.getMessages.mockResolvedValueOnce(page([makeMessage({ message_id: "m2" })], "older-2"));
    await store()[action]("c1");
    const calls = mocked.getMessages.mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[2][1]?.cursor ?? null).toBeNull();
    expect(store().threads.c1).toMatchObject({ status: "ready", olderCursor: "older-2", error: null });
    expect(store().threads.c1.messages.map((m) => m.message_id)).toEqual(["m2"]);
  });
});
