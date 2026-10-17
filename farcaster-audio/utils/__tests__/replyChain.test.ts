import { describe, expect, it } from "@jest/globals";
import { selectReplyChain } from "../replyChain";
import type { FarcasterCastWithReplies } from "@/types/farcaster";

/** Nested spec: [hash, [children...]]. Only `hash`/`direct_replies` matter. */
type Spec = [string, Spec[]?];
function tree([hash, children = []]: Spec): FarcasterCastWithReplies {
  return {
    hash,
    direct_replies: children.map(tree),
  } as unknown as FarcasterCastWithReplies;
}

const hashes = (nodes: FarcasterCastWithReplies[]) => nodes.map((n) => n.hash);

describe("selectReplyChain", () => {
  it("shows a lone reply with nothing hidden", () => {
    const { chain, continueFrom } = selectReplyChain(tree(["a"]));
    expect(hashes(chain)).toEqual(["a"]);
    expect(continueFrom).toBeNull();
  });

  it("follows a linear chain up to the cap and continues from the last shown", () => {
    const root = tree(["a", [["b", [["c", [["d"]]]]]]]);
    const { chain, continueFrom } = selectReplyChain(root, { maxLength: 3 });
    expect(hashes(chain)).toEqual(["a", "b", "c"]);
    expect(continueFrom?.hash).toBe("c");
  });

  it("follows the first reply at a branch and continues from the branch point", () => {
    const { chain, continueFrom } = selectReplyChain(tree(["a", [["b"], ["c"]]]));
    expect(hashes(chain)).toEqual(["a", "b"]);
    expect(continueFrom?.hash).toBe("a");
  });

  it("follows the branch holding the focus target past the cap", () => {
    const root = tree(["a", [["b"], ["c", [["d", [["e"]]]]]]]);
    const { chain, continueFrom } = selectReplyChain(root, {
      focusHash: "e",
      maxLength: 2,
    });
    expect(hashes(chain)).toEqual(["a", "c", "d", "e"]);
    expect(continueFrom?.hash).toBe("a");
  });
});
