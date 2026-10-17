import { normalizeCast as normalizeFeedCast } from "@/lib/api/feed";
import { normalizeCast as normalizeUserCast } from "@/lib/api/users";

const PARENT_HASH = `0x${"a".repeat(40)}`;

const reply = {
  hash: `0x${"b".repeat(40)}`,
  author: { fid: 1, username: "replier", display_name: "Replier", pfp_url: null },
  text: "well hello there old friend",
  timestamp: "2026-10-16T12:05:00Z",
  parent_hash: PARENT_HASH,
  parent_cast: {
    hash: PARENT_HASH,
    author: { fid: 7, username: "op", display_name: null, pfp_url: null },
    text: "the original",
    timestamp: "2026-10-16T12:00:00Z",
  },
};

describe.each([
  ["feed", normalizeFeedCast],
  ["users", normalizeUserCast],
])("%s normalizeCast", (_name, normalize) => {
  it("keeps the parent-cast preview", () => {
    // The backend sends author fields as null when the profile lacks them.
    const cast = normalize(reply as never);

    expect(cast.parent_cast).toEqual({
      hash: PARENT_HASH,
      author: { fid: 7, username: "op", display_name: "op", pfp_url: null },
      text: "the original",
      timestamp: "2026-10-16T12:00:00Z",
    });
  });

  it("is null when the reply has no parent preview", () => {
    const cast = normalize({ ...reply, parent_cast: undefined } as never);

    expect(cast.parent_cast).toBeNull();
  });
});
