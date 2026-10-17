import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetConversation = jest.fn<(id: string) => Promise<unknown>>();
const mockGetMessagingStatus = jest.fn<() => Promise<{ enabled: boolean }>>();

jest.mock("@/services/messagesApi", () => {
  const actual = jest.requireActual("@/services/messagesApi") as Record<string, unknown>;
  return {
    ...actual,
    getConversation: (id: string) => mockGetConversation(id),
    getMessagingStatus: () => mockGetMessagingStatus(),
  };
});
jest.mock("@/services/storage", () => ({ getTokens: async () => null }));
jest.mock("@/services/authRefresh", () => ({ refreshSession: async () => true }));

import { applyReadEvent } from "@/hooks/useMessagesBadge";
import {
  findUnreadSeparatorId,
  shouldAutoMarkRead,
  shouldReloadLatest,
  THREAD_SYNC_STALE_MS,
} from "@/hooks/useConversation";
import {
  appendUniqueHits,
  fetchMoreOrRestart,
  fetchUntilHits,
  MAX_EMPTY_PAGES_PER_FETCH,
} from "@/hooks/useMessageSearch";
import { clampOptimisticSentAt, enqueueDraftSend } from "@/hooks/useSendMessage";
import { useMessageStore, type ThreadState } from "@/stores/messageStore";
import {
  applyMessagesError,
  describeMessagesError,
  describeMessagesFailure,
  refreshMessagingAvailability,
} from "@/utils/messagesErrors";
import { MessagesApiError } from "@/services/messagesApi";
import {
  ALICE,
  BASE_TIME,
  makeConversation,
  makeMessage,
  VIEWER,
} from "@/components/messages/__fixtures__/messages";
import type { MessageSearchHit, Page } from "@/types/messages";

const hitFor = (id: string): MessageSearchHit => ({
  message: makeMessage({ message_id: id }),
  conversation: makeConversation(),
  highlights: [],
  before: [],
  after: [],
});

describe("fetchUntilHits", () => {
  it("keeps paging past empty pages until a hit or the end", async () => {
    const pages: Page<MessageSearchHit>[] = [
      { items: [], next_cursor: "p2" },
      { items: [], next_cursor: "p3" },
      { items: [hitFor("h")], next_cursor: "p4" },
    ];
    const cursors: (string | null)[] = [];
    const result = await fetchUntilHits(async (cursor) => {
      cursors.push(cursor);
      return pages[cursors.length - 1];
    }, null);
    expect(cursors).toEqual([null, "p2", "p3"]);
    expect(result.items.map((h) => h.message.message_id)).toEqual(["h"]);
    expect(result.nextCursor).toBe("p4");
  });

  it("stops at a null cursor and bounds runaway empty pages", async () => {
    const done = await fetchUntilHits(async () => ({ items: [], next_cursor: null }), "c");
    expect(done).toEqual({ items: [], nextCursor: null });

    const fetchPage = jest.fn(async () => ({ items: [], next_cursor: "again" }));
    const bounded = await fetchUntilHits(fetchPage, null);
    expect(fetchPage).toHaveBeenCalledTimes(MAX_EMPTY_PAGES_PER_FETCH);
    expect(bounded.nextCursor).toBe("again");
  });
});

describe("appendUniqueHits", () => {
  it("appends new hits in order and drops repeats", () => {
    const first = [hitFor("a"), hitFor("b")];
    const merged = appendUniqueHits(first, [hitFor("b"), hitFor("c"), hitFor("c")]);
    expect(merged.map((h) => h.message.message_id)).toEqual(["a", "b", "c"]);
    expect(appendUniqueHits(first, [hitFor("a")])).toBe(first);
  });
});

describe("shouldAutoMarkRead", () => {
  it("marks on first sight only when unread", () => {
    expect(shouldAutoMarkRead({ lastMarkedKey: undefined, key: "m1", hasUnread: true })).toBe(true);
    expect(shouldAutoMarkRead({ lastMarkedKey: undefined, key: "m1", hasUnread: false })).toBe(false);
  });

  it("never re-marks the same newest message, so manual unread sticks", () => {
    expect(shouldAutoMarkRead({ lastMarkedKey: "m1", key: "m1", hasUnread: true })).toBe(false);
  });

  it("marks when a new incoming message arrives", () => {
    expect(shouldAutoMarkRead({ lastMarkedKey: "m1", key: "m2", hasUnread: false })).toBe(true);
    expect(shouldAutoMarkRead({ lastMarkedKey: "m1", key: "", hasUnread: true })).toBe(false);
  });
});

describe("findUnreadSeparatorId", () => {
  const incoming = (id: string, extra = {}) => makeMessage({ message_id: id, sender: ALICE, ...extra });
  const own = (id: string) => makeMessage({ message_id: id, sender: VIEWER });

  it("uses the viewer's last-read marker when it is in the window", () => {
    const messages = [incoming("i3"), own("o1"), incoming("i2"), incoming("i1", { is_last_read: true })];
    expect(findUnreadSeparatorId(messages, VIEWER.fid, 2)).toBe("i2");
  });

  it("counts back unread incoming messages otherwise", () => {
    const messages = [incoming("i3"), own("o1"), incoming("i2"), incoming("i1")];
    expect(findUnreadSeparatorId(messages, VIEWER.fid, 2)).toBe("i2");
    expect(findUnreadSeparatorId(messages, VIEWER.fid, 99)).toBe("i1");
  });

  it("shows nothing when read or when the marker is the newest message", () => {
    expect(findUnreadSeparatorId([incoming("i1")], VIEWER.fid, 0)).toBeNull();
    expect(
      findUnreadSeparatorId([incoming("i1", { is_last_read: true })], VIEWER.fid, 1),
    ).toBeNull();
  });
});

describe("enqueueDraftSend", () => {
  it("runs sends for one draft strictly in order, even after a failure", async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = enqueueDraftSend("draft:1", async () => {
      await gate;
      order.push("first");
      throw new Error("boom");
    });
    const second = enqueueDraftSend("draft:1", async () => {
      order.push("second");
      return "ok";
    });
    // The second send must wait for the first even while it is blocked.
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseFirst();
    await expect(first).rejects.toThrow("boom");
    await expect(second).resolves.toBe("ok");
    expect(order).toEqual(["first", "second"]);
  });
});

describe("clampOptimisticSentAt", () => {
  it("never sorts a new send above the newest loaded message", () => {
    const newest = makeMessage({ sent_at: BASE_TIME });
    expect(clampOptimisticSentAt(BASE_TIME - 5_000, newest)).toBe(BASE_TIME + 1);
    expect(clampOptimisticSentAt(BASE_TIME + 10, newest)).toBe(BASE_TIME + 10);
    expect(clampOptimisticSentAt(7, undefined)).toBe(7);
  });
});

describe("applyReadEvent", () => {
  beforeEach(() => {
    useMessageStore.getState().reset();
    mockGetConversation.mockReset();
  });

  it("clears the viewer's unread for viewer (and legacy) frames", async () => {
    useMessageStore.getState().upsertConversation(makeConversation({ unread_count: 4 }));
    await applyReadEvent("c1", "viewer");
    expect(useMessageStore.getState().conversations.c1.unread_count).toBe(0);
    expect(mockGetConversation).not.toHaveBeenCalled();
  });

  it("only updates peer_last_read_at for peer frames", async () => {
    useMessageStore
      .getState()
      .upsertConversation(makeConversation({ unread_count: 4, peer_last_read_at: 0 }));
    mockGetConversation.mockResolvedValue(
      makeConversation({ unread_count: 0, peer_last_read_at: BASE_TIME }),
    );
    await applyReadEvent("c1", "peer");
    const conversation = useMessageStore.getState().conversations.c1;
    expect(conversation.peer_last_read_at).toBe(BASE_TIME);
    expect(conversation.unread_count).toBe(4);
  });

  it("ignores peer frames for conversations not in the store", async () => {
    await applyReadEvent("missing", "peer");
    expect(mockGetConversation).not.toHaveBeenCalled();
  });
});

describe("refreshMessagingAvailability", () => {
  beforeEach(() => {
    useMessageStore.getState().reset();
    mockGetMessagingStatus.mockReset();
  });

  it("hides messaging when the feature is off and shares one request", async () => {
    mockGetMessagingStatus.mockResolvedValue({ enabled: false });
    await Promise.all([refreshMessagingAvailability(), refreshMessagingAvailability()]);
    expect(mockGetMessagingStatus).toHaveBeenCalledTimes(1);
    expect(useMessageStore.getState().availability).toBe("unavailable");
  });

  it("clears the flag when the feature is back on", async () => {
    useMessageStore.getState().setAvailability("unavailable");
    mockGetMessagingStatus.mockResolvedValue({ enabled: true });
    await refreshMessagingAvailability();
    expect(useMessageStore.getState().availability).toBe("unknown");
  });

  it("changes nothing when the probe fails", async () => {
    useMessageStore.getState().setAvailability("unavailable");
    mockGetMessagingStatus.mockRejectedValue(new Error("offline"));
    await refreshMessagingAvailability();
    expect(useMessageStore.getState().availability).toBe("unavailable");
  });
});

describe("fetchMoreOrRestart", () => {
  it("continues from the cursor when it decodes", async () => {
    const fetchFrom = jest.fn(async (cursor: string | null) => ({
      items: [hitFor(`from-${cursor}`)],
      nextCursor: "next",
    }));
    const result = await fetchMoreOrRestart(fetchFrom, "p2");
    expect(fetchFrom.mock.calls.map((c) => c[0])).toEqual(["p2"]);
    expect(result.isRestart).toBe(false);
    expect(result.items[0].message.message_id).toBe("from-p2");
  });

  it("drops an invalid cursor and reloads from the first page once", async () => {
    const fetchFrom = jest.fn(async (cursor: string | null) => {
      if (cursor) throw new MessagesApiError("invalid_cursor", 400);
      return { items: [hitFor("first")], nextCursor: "p2" };
    });
    const result = await fetchMoreOrRestart(fetchFrom, "ts1.bad");
    expect(fetchFrom.mock.calls.map((c) => c[0])).toEqual(["ts1.bad", null]);
    expect(result).toMatchObject({ isRestart: true, nextCursor: "p2" });
    expect(result.items[0].message.message_id).toBe("first");
  });

  it("rethrows any other failure without restarting", async () => {
    const fetchFrom = jest.fn(async () => {
      throw new MessagesApiError("upstream_error", 502);
    });
    await expect(fetchMoreOrRestart(fetchFrom, "p2")).rejects.toMatchObject({
      code: "upstream_error",
    });
    expect(fetchFrom).toHaveBeenCalledTimes(1);
  });
});

describe("upstream_rejected copy", () => {
  beforeEach(() => {
    useMessageStore.getState().reset();
    mockGetMessagingStatus.mockClear();
  });

  it("says Farcaster rejected the message and appends upstream's reason", () => {
    expect(describeMessagesError("upstream_rejected")).toBe("Farcaster rejected this message.");
    expect(describeMessagesError("upstream_rejected", "Recipient blocks DMs")).toBe(
      "Farcaster rejected this message. Recipient blocks DMs",
    );
    // Only upstream_rejected carries a reason.
    expect(describeMessagesError("upstream_error", "ignored")).toBe(
      describeMessagesError("upstream_error"),
    );
  });

  it("describes a failure from the error itself", () => {
    const error = new MessagesApiError("upstream_rejected", 422, "Too long");
    expect(describeMessagesFailure(error)).toBe("Farcaster rejected this message. Too long");
    expect(describeMessagesFailure(new MessagesApiError("upstream_rejected", 422))).toBe(
      "Farcaster rejected this message.",
    );
  });

  it("is not treated as an outage or a token problem", () => {
    useMessageStore.getState().setAvailability("available");
    expect(applyMessagesError(new MessagesApiError("upstream_rejected", 422, "x"))).toBe(
      "upstream_rejected",
    );
    const state = useMessageStore.getState();
    expect(state.availability).toBe("available");
    expect(state.accessError).toBeNull();
    expect(mockGetMessagingStatus).not.toHaveBeenCalled();
  });
});

describe("shouldReloadLatest", () => {
  const NOW = BASE_TIME + 60 * 60_000;
  const thread = (overrides: Partial<ThreadState> = {}): ThreadState => ({
    messages: [makeMessage({ message_id: "m2" }), makeMessage({ message_id: "m1" })],
    olderCursor: null,
    hasOlder: false,
    newerCursor: null,
    hasNewer: false,
    isDetached: false,
    isLoaded: true,
    syncedAt: NOW - 1_000,
    ...overrides,
  });
  const recent = (...ids: string[]) => ids.map((id) => makeMessage({ message_id: id }));

  it("merges a fresh, overlapping /recent", () => {
    expect(shouldReloadLatest({ thread: thread(), recent: recent("m3", "m2"), now: NOW })).toBe(false);
    expect(shouldReloadLatest({ thread: thread(), recent: [], now: NOW })).toBe(false);
  });

  it("reloads when /recent shares no id with the window (a gap)", () => {
    expect(shouldReloadLatest({ thread: thread(), recent: recent("m9", "m8"), now: NOW })).toBe(true);
  });

  it("reloads when the last sync is older than the window or unknown", () => {
    const stale = thread({ syncedAt: NOW - THREAD_SYNC_STALE_MS - 1 });
    expect(shouldReloadLatest({ thread: stale, recent: recent("m3", "m2"), now: NOW })).toBe(true);
    expect(shouldReloadLatest({ thread: thread({ syncedAt: null }), recent: [], now: NOW })).toBe(true);
  });

  it("leaves detached and unloaded windows to their own paging", () => {
    expect(
      shouldReloadLatest({ thread: thread({ isDetached: true, syncedAt: null }), recent: recent("m9"), now: NOW }),
    ).toBe(false);
    expect(shouldReloadLatest({ thread: undefined, recent: recent("m9"), now: NOW })).toBe(false);
    expect(
      shouldReloadLatest({ thread: thread({ isLoaded: false }), recent: recent("m9"), now: NOW }),
    ).toBe(false);
  });
});
