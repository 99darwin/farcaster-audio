import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";
import type { InboxResponse } from "@/types/messages";

type GetInboxArgs = { category: string; cursor: string | null };
const mockGetInbox = jest.fn<(args: GetInboxArgs) => Promise<InboxResponse>>();

jest.mock("@/services/messagesApi", () => {
  const actual = jest.requireActual("@/services/messagesApi") as Record<string, unknown>;
  return { ...actual, getInbox: (args: GetInboxArgs) => mockGetInbox(args) };
});
jest.mock("@/services/storage", () => ({ getTokens: async () => null }));
jest.mock("@/services/authRefresh", () => ({ refreshSession: async () => true }));

import { INBOX_PAGE_MODE, INBOX_POLL_MS, useInbox } from "@/hooks/useInbox";
import { MessagesApiError } from "@/services/messagesApi";
import { useMessageStore, type InboxSegment } from "@/stores/messageStore";
import { makeConversation } from "@/components/messages/__fixtures__/messages";

const inboxPage = (ids: string[], nextCursor: string | null): InboxResponse => ({
  items: ids.map((id) => makeConversation({ conversation_id: id })),
  next_cursor: nextCursor,
  requests_count: 0,
  has_unread_requests: false,
  has_archived: false,
});

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  useMessageStore.getState().reset();
  mockGetInbox.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("INBOX_PAGE_MODE", () => {
  it("only lets the first load replace the list", () => {
    expect(INBOX_PAGE_MODE).toEqual({
      initial: "replace",
      refresh: "merge",
      poll: "merge",
      more: "append",
    });
  });
});

describe("useInbox", () => {
  it("a slow poll doesn't swallow loadMore, and the poll keeps paged-in rows", async () => {
    mockGetInbox.mockResolvedValueOnce(inboxPage(["a", "b"], "p2"));
    const { result } = renderHook(() =>
      useInbox({ segment: "default", isEnabled: true, isFocused: true }),
    );
    await flush();
    expect(result.current.conversations.map((c) => c.conversation_id)).toEqual(["a", "b"]);

    let resolvePoll: (page: InboxResponse) => void = () => {};
    mockGetInbox.mockImplementationOnce(
      () => new Promise<InboxResponse>((resolve) => (resolvePoll = resolve)),
    );
    await act(async () => {
      jest.advanceTimersByTime(INBOX_POLL_MS);
    });
    mockGetInbox.mockResolvedValueOnce(inboxPage(["c", "d"], null));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(mockGetInbox).toHaveBeenLastCalledWith({ category: "default", cursor: "p2" });
    expect(result.current.conversations.map((c) => c.conversation_id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);

    await act(async () => resolvePoll(inboxPage(["b", "a"], "p2")));
    await flush();
    expect(result.current.conversations.map((c) => c.conversation_id)).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
    expect(result.current.hasMore).toBe(false);
  });

  it("clears the error when switching segments", async () => {
    mockGetInbox.mockRejectedValueOnce(new MessagesApiError("upstream_error", 502));
    const { result, rerender } = renderHook(
      ({ segment }: { segment: InboxSegment }) =>
        useInbox({ segment, isEnabled: true, isFocused: true }),
      { initialProps: { segment: "default" as InboxSegment } },
    );
    await flush();
    expect(result.current.errorCode).toBe("upstream_error");

    // The new segment's first load is still in flight: only the switch
    // itself can clear the old segment's error.
    mockGetInbox.mockImplementationOnce(() => new Promise<InboxResponse>(() => {}));
    rerender({ segment: "request" });
    await flush();
    expect(mockGetInbox).toHaveBeenLastCalledWith({ category: "request", cursor: null });
    expect(result.current.errorCode).toBeNull();
  });
});
