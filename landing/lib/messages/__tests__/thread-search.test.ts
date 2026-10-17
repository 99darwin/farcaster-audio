import { ApiFetchError } from "@/lib/api/client";
import { INVALID_CURSOR } from "@/lib/api/messages";
import type { MessageSearchHit } from "@/lib/api/messages.types";
import {
  MAX_THREAD_SEARCH_PAGES,
  MIN_REMOTE_QUERY_LENGTH,
  collectThreadSearchHits,
  shouldSearchRemotely,
} from "@/lib/messages/thread-search";
import { makeConversation, makeMessage } from "./fixtures";

function hit(id: string): MessageSearchHit {
  return { message: makeMessage({ message_id: id }), conversation: makeConversation(), highlights: [], before: [], after: [] };
}

describe("collectThreadSearchHits", () => {
  it("keeps paging through empty pages until next_cursor is null", async () => {
    const pages: Record<string, { items: MessageSearchHit[]; next_cursor: string | null }> = {
      start: { items: [hit("a")], next_cursor: "p2" },
      p2: { items: [], next_cursor: "p3" },
      p3: { items: [hit("b"), hit("a")], next_cursor: null },
    };
    const fetchPage = jest.fn(async (cursor: string | null) => pages[cursor ?? "start"]);
    const onProgress = jest.fn();
    const hits = await collectThreadSearchHits(fetchPage, { onProgress });
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, "p2", "p3"]);
    expect(hits.map((h) => h.message.message_id)).toEqual(["a", "b"]);
    expect(onProgress).toHaveBeenCalledTimes(3);
  });

  it("stops when cancelled, on a repeated cursor, or at the page cap", async () => {
    let cancelled = false;
    const fetchPage = jest.fn(async () => {
      cancelled = true;
      return { items: [hit("a")], next_cursor: "same" };
    });
    const onProgress = jest.fn();
    await collectThreadSearchHits(fetchPage, { onProgress, isCancelled: () => cancelled });
    expect(onProgress).not.toHaveBeenCalled();

    const repeating = jest.fn(async () => ({ items: [], next_cursor: "same" }));
    await collectThreadSearchHits(repeating, { onProgress });
    expect(repeating).toHaveBeenCalledTimes(2);

    let n = 0;
    const endless = jest.fn(async () => ({ items: [], next_cursor: `c${(n += 1)}` }));
    await collectThreadSearchHits(endless, { onProgress, maxPages: 3 });
    expect(endless).toHaveBeenCalledTimes(3);
  });
});

describe("collectThreadSearchHits on a stale cursor", () => {
  const stale = () => new ApiFetchError(400, INVALID_CURSOR);

  it("restarts from the first page once and dedupes", async () => {
    const fetchPage = jest
      .fn<Promise<{ items: MessageSearchHit[]; next_cursor: string | null }>, [string | null]>()
      .mockResolvedValueOnce({ items: [hit("a")], next_cursor: "stale" })
      .mockRejectedValueOnce(stale())
      .mockResolvedValueOnce({ items: [hit("b"), hit("a")], next_cursor: null });
    const hits = await collectThreadSearchHits(fetchPage, { onProgress: jest.fn() });
    expect(fetchPage.mock.calls.map(([cursor]) => cursor)).toEqual([null, "stale", null]);
    expect(hits.map((h) => h.message.message_id).sort()).toEqual(["a", "b"]);
  });

  it("gives up on a second stale cursor or any other error", async () => {
    const twice = jest
      .fn<Promise<{ items: MessageSearchHit[]; next_cursor: string | null }>, [string | null]>()
      .mockResolvedValueOnce({ items: [], next_cursor: "x" })
      .mockRejectedValueOnce(stale())
      .mockResolvedValueOnce({ items: [], next_cursor: "y" })
      .mockRejectedValueOnce(stale());
    await expect(collectThreadSearchHits(twice, { onProgress: jest.fn() })).rejects.toMatchObject({
      status: 400,
      detail: INVALID_CURSOR,
    });
    expect(twice).toHaveBeenCalledTimes(4);
    const other = jest.fn().mockRejectedValueOnce(new ApiFetchError(500));
    await expect(collectThreadSearchHits(other, { onProgress: jest.fn() })).rejects.toMatchObject({ status: 500 });
  });
});

describe("remote search limits", () => {
  it("searches the server only from 3 trimmed characters", () => {
    expect(MIN_REMOTE_QUERY_LENGTH).toBe(3);
    for (const query of ["", "a", "ab", "  ab  "]) expect(shouldSearchRemotely(query)).toBe(false);
    for (const query of ["abc", " abc ", "hello"]) expect(shouldSearchRemotely(query)).toBe(true);
  });

  it("caps remote paging at 10 pages by default", async () => {
    expect(MAX_THREAD_SEARCH_PAGES).toBe(10);
    let n = 0;
    const endless = jest.fn(async () => ({ items: [hit(`m${n}`)], next_cursor: `c${(n += 1)}` }));
    const hits = await collectThreadSearchHits(endless, { onProgress: jest.fn() });
    expect(endless).toHaveBeenCalledTimes(10);
    expect(hits).toHaveLength(10);
  });
});
