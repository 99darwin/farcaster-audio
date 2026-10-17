import type { Message } from "@/lib/api/messages.types";
import {
  MAX_UNREAD_DIVIDER_PAGES,
  afterIdByLastRead,
  resolveUnreadDivider,
  type UnreadDividerInput,
} from "@/lib/messages/unread-divider";
import { ALICE, BASE_TIME, BOB, MINUTE, makeMessage } from "./fixtures";

/** Oldest first; `own` ids are sent by the viewer (ALICE). */
function thread(ids: string[], own: string[] = []): Message[] {
  return ids.map((id, index) =>
    makeMessage({ message_id: id, sender: own.includes(id) ? ALICE : BOB, sent_at: BASE_TIME + index * MINUTE }),
  );
}

function resolve(overrides: Partial<UnreadDividerInput>) {
  return resolveUnreadDivider({
    messages: [],
    unreadCount: 0,
    viewerFid: ALICE.fid,
    lastReadAt: 0,
    hasOlder: false,
    pagesLoaded: 0,
    ...overrides,
  });
}

describe("resolveUnreadDivider", () => {
  it("has no divider when nothing is unread", () => {
    expect(resolve({ messages: thread(["a", "b"]) })).toEqual({ kind: "found", afterId: null });
  });

  it("places the divider before the oldest unread incoming message", () => {
    const messages = thread(["a", "b", "mine", "c", "d"], ["mine"]);
    // c and d are unread; the viewer's own message does not count.
    expect(resolve({ messages, unreadCount: 2 })).toEqual({ kind: "found", afterId: "mine" });
    expect(resolve({ messages, unreadCount: 3 })).toEqual({ kind: "found", afterId: "a" });
  });

  it("asks for older pages while unread_count exceeds the loaded page", () => {
    const messages = thread(["a", "b", "c"]);
    expect(resolve({ messages, unreadCount: 10, hasOlder: true })).toEqual({ kind: "load_older" });
    // Exactly the oldest loaded is the target: one more page to find its predecessor.
    expect(resolve({ messages, unreadCount: 3, hasOlder: true })).toEqual({ kind: "load_older" });
  });

  it("stops paging at the bound and anchors on last_read_at", () => {
    const messages = thread(["a", "b", "c", "d"]);
    const lastReadAt = messages[1].sent_at;
    expect(
      resolve({ messages, unreadCount: 50, hasOlder: true, pagesLoaded: MAX_UNREAD_DIVIDER_PAGES, lastReadAt }),
    ).toEqual({ kind: "found", afterId: "b" });
  });

  it("anchors on last_read_at once history runs out", () => {
    const messages = thread(["a", "b", "c"]);
    expect(resolve({ messages, unreadCount: 9, lastReadAt: messages[0].sent_at })).toEqual({
      kind: "found",
      afterId: "a",
    });
    // Everything is unread from the very first message: no divider needed.
    expect(resolve({ messages, unreadCount: 3 })).toEqual({ kind: "found", afterId: null });
  });

  it("has no divider without a usable last_read_at when paging gives up", () => {
    const messages = thread(["a", "b"]);
    expect(resolve({ messages, unreadCount: 9, hasOlder: true, pagesLoaded: MAX_UNREAD_DIVIDER_PAGES })).toEqual({
      kind: "found",
      afterId: null,
    });
  });
});

describe("afterIdByLastRead", () => {
  it("skips the viewer's own messages and needs a timestamp", () => {
    const messages = thread(["a", "mine", "b"], ["mine"]);
    expect(afterIdByLastRead(messages, messages[0].sent_at, ALICE.fid)).toBe("mine");
    expect(afterIdByLastRead(messages, 0, ALICE.fid)).toBeNull();
    expect(afterIdByLastRead(messages, messages[2].sent_at, ALICE.fid)).toBeNull();
  });
});
