import {
  normalizeCastNode,
  updateTree,
  partitionSpamFromTree,
  removeFromTree,
  insertReply,
  subtreeContainsHash,
  findTopLevelIndexContaining,
  selectReplyChain,
  type CastNode,
} from "@/lib/thread/thread-tree";
import type { RawCast } from "@/lib/api/users";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rawAuthor(fid: number, isSpam = false) {
  return {
    fid,
    username: `u${fid}`,
    display_name: `User ${fid}`,
    pfp_url: null,
    is_spam: isSpam,
  };
}

/**
 * Fixture conversation:
 *   a
 *   ├─ b
 *   │  └─ d
 *   └─ c   (spam author)
 */
function rawTree(): RawCast[] {
  return [
    {
      hash: "a",
      author: rawAuthor(1),
      text: "a",
      direct_replies: [
        {
          hash: "b",
          author: rawAuthor(2),
          text: "b",
          direct_replies: [{ hash: "d", author: rawAuthor(4), text: "d" }],
        },
      ],
    },
    { hash: "c", author: rawAuthor(3, true), text: "c" },
  ];
}

function buildForest(): CastNode[] {
  return rawTree().map(normalizeCastNode);
}

// ---------------------------------------------------------------------------
// normalizeCastNode
// ---------------------------------------------------------------------------

describe("normalizeCastNode", () => {
  it("recursively maps direct_replies into a CastNode forest", () => {
    const nodes = buildForest();
    expect(nodes).toHaveLength(2);
    expect(nodes[0].hash).toBe("a");
    expect(nodes[0].replies[0].hash).toBe("b");
    expect(nodes[0].replies[0].replies[0].hash).toBe("d");
    // Leaf nodes get an empty (not undefined) replies array.
    expect(nodes[1].replies).toEqual([]);
  });

  it("surfaces author.is_spam as authorIsSpam", () => {
    const nodes = buildForest();
    expect(nodes[0].authorIsSpam).toBe(false);
    expect(nodes[1].authorIsSpam).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updateTree — structural sharing
// ---------------------------------------------------------------------------

describe("updateTree", () => {
  it("applies fn to the matching node at any depth", () => {
    const before = buildForest();
    const after = updateTree(before, "d", (n) => ({ ...n, text: "edited" }));
    expect(after[0].replies[0].replies[0].text).toBe("edited");
  });

  it("preserves identity of untouched subtrees (structural sharing)", () => {
    const before = buildForest();
    const after = updateTree(before, "d", (n) => ({ ...n, text: "edited" }));

    // Touched path: new objects along a→b→d.
    expect(after).not.toBe(before);
    expect(after[0]).not.toBe(before[0]);
    expect(after[0].replies[0]).not.toBe(before[0].replies[0]);
    expect(after[0].replies[0].replies[0]).not.toBe(
      before[0].replies[0].replies[0],
    );

    // Untouched sibling `c` keeps object identity.
    expect(after[1]).toBe(before[1]);
  });

  it("returns the same array reference when nothing matches", () => {
    const before = buildForest();
    const after = updateTree(before, "nonexistent", (n) => n);
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// partitionSpamFromTree
// ---------------------------------------------------------------------------

describe("partitionSpamFromTree", () => {
  it("hoists spam nodes and keeps clean ones", () => {
    const { clean, spam } = partitionSpamFromTree(buildForest());
    expect(clean.map((n) => n.hash)).toEqual(["a"]);
    expect(spam.map((n) => n.hash)).toEqual(["c"]);
    // Clean subtree is preserved intact.
    expect(clean[0].replies[0].hash).toBe("b");
  });

  it("prunes a spam child out of an otherwise-clean parent", () => {
    const raw: RawCast[] = [
      {
        hash: "p",
        author: rawAuthor(1),
        direct_replies: [
          { hash: "s", author: rawAuthor(9, true) },
          { hash: "ok", author: rawAuthor(2) },
        ],
      },
    ];
    const { clean, spam } = partitionSpamFromTree(raw.map(normalizeCastNode));
    expect(clean[0].replies.map((n) => n.hash)).toEqual(["ok"]);
    expect(spam.map((n) => n.hash)).toEqual(["s"]);
  });
});

// ---------------------------------------------------------------------------
// removeFromTree
// ---------------------------------------------------------------------------

describe("removeFromTree", () => {
  it("removes a top-level node by hash", () => {
    const before = buildForest();
    const after = removeFromTree(before, "c");
    expect(after.map((n) => n.hash)).toEqual(["a"]);
    expect(after).not.toBe(before);
  });

  it("removes a nested reply and preserves structural sharing on untouched paths", () => {
    const before = buildForest();
    // Remove "d" (nested under a→b)
    const after = removeFromTree(before, "d");
    expect(after[0].replies[0].replies).toHaveLength(0);
    // "c" (sibling of "a") must keep identity.
    expect(after[1]).toBe(before[1]);
  });

  it("returns the same array reference when hash is not found", () => {
    const before = buildForest();
    const after = removeFromTree(before, "nonexistent");
    expect(after).toBe(before);
  });

  it("drops the entire subtree of the removed node", () => {
    const before = buildForest();
    // Remove "b" → its child "d" must also be gone.
    const after = removeFromTree(before, "b");
    expect(after[0].replies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// insertReply
// ---------------------------------------------------------------------------

describe("insertReply", () => {
  function replyNode(hash: string): CastNode {
    return normalizeCastNode({ hash, author: rawAuthor(9), text: hash });
  }

  it("prepends a reply as the first child of the matching parent", () => {
    const before = buildForest();
    const after = insertReply(before, "b", replyNode("new"));
    expect(after[0].replies[0].replies[0].hash).toBe("new");
    // Existing child "d" is retained after the newly-inserted node.
    expect(after[0].replies[0].replies[1].hash).toBe("d");
  });

  it("bumps the parent's replies_count", () => {
    const before = buildForest();
    const parentBefore = before[0].replies[0].reactions.replies_count;
    const after = insertReply(before, "b", replyNode("new"));
    expect(after[0].replies[0].reactions.replies_count).toBe(parentBefore + 1);
  });

  it("preserves structural sharing for untouched branches", () => {
    const before = buildForest();
    const after = insertReply(before, "b", replyNode("new"));
    expect(after).not.toBe(before);
    // Sibling "c" keeps identity.
    expect(after[1]).toBe(before[1]);
  });

  it("returns the same reference when the parent is not found", () => {
    const before = buildForest();
    const after = insertReply(before, "nope", replyNode("new"));
    expect(after).toBe(before);
  });

  it("is idempotent — never inserts a reply whose hash already exists", () => {
    const before = buildForest();
    const after = insertReply(before, "b", replyNode("d")); // "d" already present
    expect(after).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// subtree search
// ---------------------------------------------------------------------------

describe("subtreeContainsHash / findTopLevelIndexContaining", () => {
  it("finds a hash nested in a subtree", () => {
    const nodes = buildForest();
    expect(subtreeContainsHash(nodes[0], "d")).toBe(true);
    expect(subtreeContainsHash(nodes[0], "c")).toBe(false);
  });

  it("returns the top-level index whose subtree contains the hash", () => {
    const nodes = buildForest();
    expect(findTopLevelIndexContaining(nodes, "d")).toBe(0);
    expect(findTopLevelIndexContaining(nodes, "c")).toBe(1);
    expect(findTopLevelIndexContaining(nodes, "missing")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// selectReplyChain — X-style flat reply groups
// ---------------------------------------------------------------------------

/** Build a node tree from a nested spec: [hash, [children...]]. */
type Spec = [string, Spec[]?];
function rawSpec([hash, children = []]: Spec): RawCast {
  return {
    hash,
    author: rawAuthor(1),
    text: hash,
    direct_replies: children.map(rawSpec),
  };
}

function tree(spec: Spec): CastNode {
  return normalizeCastNode(rawSpec(spec));
}

function hashes(nodes: CastNode[]): string[] {
  return nodes.map((n) => n.hash);
}

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
    const root = tree(["a", [["b"], ["c"]]]);
    const { chain, continueFrom } = selectReplyChain(root);
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
