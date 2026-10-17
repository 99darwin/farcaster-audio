import { inboxActivityAt, mergeInboxRefresh } from "@/lib/messages/inbox-merge";
import { BASE_TIME, MINUTE, makeConversation, makeMessage } from "./fixtures";

const at = (id: string, minutesAgo: number, pinned = false) =>
  makeConversation({
    conversation_id: id,
    pinned,
    last_message: makeMessage({ conversation_id: id, sent_at: BASE_TIME - minutesAgo * MINUTE }),
  });

function byId(...conversations: ReturnType<typeof at>[]) {
  return Object.fromEntries(conversations.map((c) => [c.conversation_id, c]));
}

describe("inboxActivityAt", () => {
  it("falls back to created_at without a last message", () => {
    expect(inboxActivityAt(makeConversation({ created_at: 42 }))).toBe(42);
    expect(inboxActivityAt(at("a", 0))).toBe(BASE_TIME);
  });
});

describe("mergeInboxRefresh", () => {
  const existing = { ids: ["a", "b", "c", "d"], cursor: "p3", hasMore: true };

  it("keeps the older tail with the existing cursor", () => {
    const conversations = byId(at("d", 0), at("a", 1), at("b", 2), at("c", 3));
    expect(mergeInboxRefresh({ existing, pageIds: ["d", "a"], nextCursor: "p2", conversations })).toEqual({
      ids: ["d", "a", "b", "c"],
      cursor: "p3",
      hasMore: true,
    });
  });

  it("drops ids inside page 1's range that the page no longer lists", () => {
    const conversations = byId(at("a", 1), at("b", 2), at("c", 3), at("d", 4));
    expect(mergeInboxRefresh({ existing, pageIds: ["a", "c"], nextCursor: "p2", conversations }).ids).toEqual([
      "a",
      "c",
      "d",
    ]);
  });

  it("ignores pinned rows for the boundary and in the tail", () => {
    const conversations = byId(at("p", 100, true), at("a", 1), at("b", 2), at("c", 3, true));
    expect(
      mergeInboxRefresh({
        existing: { ids: ["p", "a", "b", "c"], cursor: "p3", hasMore: true },
        pageIds: ["p", "a"],
        nextCursor: "p2",
        conversations,
      }).ids,
    ).toEqual(["p", "a", "b"]);
  });

  it("treats a final page as authoritative", () => {
    const conversations = byId(at("a", 1), at("b", 2));
    expect(mergeInboxRefresh({ existing, pageIds: ["a"], nextCursor: null, conversations })).toEqual({
      ids: ["a"],
      cursor: null,
      hasMore: false,
    });
  });

  it("returns page 1 when nothing older is kept", () => {
    const conversations = byId(at("a", 1), at("b", 2));
    expect(
      mergeInboxRefresh({ existing: { ids: ["a"], cursor: "p2", hasMore: true }, pageIds: ["b", "a"], nextCursor: "x", conversations }),
    ).toEqual({ ids: ["b", "a"], cursor: "x", hasMore: true });
  });
});
