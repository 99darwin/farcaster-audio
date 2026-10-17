import { describe, expect, it } from "@jest/globals";
import {
  appendUniqueCasts,
  conversationParent,
  removeCastsByAuthor,
  updateCastBookmark,
  updateCastReaction,
} from "../castUpdates";
import type { FarcasterCast } from "@/types/farcaster";

const MY_FID = 1;

function makeCast(
  hash: string,
  overrides: Partial<FarcasterCast> = {},
): FarcasterCast {
  return {
    hash,
    author: { fid: 7, username: "a", display_name: "A", pfp_url: null },
    text: hash,
    timestamp: "2026-10-16T12:00:00Z",
    reactions: { likes_count: 0, recasts_count: 0, likes: [], recasts: [] },
    replies: { count: 0 },
    thread_hash: null,
    parent_hash: null,
    ...overrides,
  } as FarcasterCast;
}

function makeReply(hash: string, parent: FarcasterCast): FarcasterCast {
  return makeCast(hash, { parent_hash: parent.hash, parent_cast: parent });
}

describe("conversationParent", () => {
  it("returns a full parent but not a legacy preview", () => {
    const parent = makeCast("0xp");
    expect(conversationParent(makeReply("0xr", parent))).toBe(parent);

    const preview = makeCast("0xr", {
      parent_cast: { hash: "0xp", author: { fid: 7 }, text: "hi" },
    });
    expect(conversationParent(preview)).toBeNull();
  });
});

describe("updateCastReaction", () => {
  it("updates a matching parent rendered above a reply", () => {
    const [reply] = updateCastReaction([makeReply("0xr", makeCast("0xp"))], {
      hash: "0xp",
      type: "like",
      added: true,
      myFid: MY_FID,
    });

    const parent = conversationParent(reply);
    expect(parent?.reactions.likes_count).toBe(1);
    expect(parent?.viewer_context?.liked).toBe(true);
    expect(reply.reactions.likes_count).toBe(0);
  });

  it("removes a recast without going below zero", () => {
    const [cast] = updateCastReaction([makeCast("0xa")], {
      hash: "0xa",
      type: "recast",
      added: false,
      myFid: MY_FID,
    });

    expect(cast.reactions.recasts_count).toBe(0);
    expect(cast.viewer_context?.recasted).toBe(false);
  });
});

describe("updateCastBookmark", () => {
  it("bookmarks top-level casts and parents", () => {
    const [cast, reply] = updateCastBookmark(
      [makeCast("0xp"), makeReply("0xr", makeCast("0xp"))],
      "0xp",
      true,
    );

    expect(cast.viewer_context?.bookmarked).toBe(true);
    expect(conversationParent(reply)?.viewer_context?.bookmarked).toBe(true);
    expect(reply.viewer_context?.bookmarked).toBeUndefined();
  });
});

describe("removeCastsByAuthor", () => {
  it("drops conversations whose parent the blocked author wrote", () => {
    const blockedParent = makeCast("0xp", {
      author: { fid: 99, username: "b", display_name: "B", pfp_url: null },
    });

    const casts = removeCastsByAuthor(
      [makeReply("0xr", blockedParent), makeCast("0xa")],
      99,
    );

    expect(casts.map((c) => c.hash)).toEqual(["0xa"]);
  });
});

describe("appendUniqueCasts", () => {
  it("skips casts already shown as a post or as a parent", () => {
    const existing = [makeReply("0xr", makeCast("0xp")), makeCast("0xa")];
    const incoming = [
      makeCast("0xp"),
      makeReply("0xr2", makeCast("0xa")),
      makeCast("0xb"),
    ];

    const casts = appendUniqueCasts(existing, incoming);

    expect(casts.map((c) => c.hash)).toEqual(["0xr", "0xa", "0xb"]);
  });
});
