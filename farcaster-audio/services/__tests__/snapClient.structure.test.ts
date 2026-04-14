import { describe, expect, it } from "@jest/globals";
import { validateSnapStructure } from "../snapClient";
import type { SnapResponse, SnapElement } from "@/types/snap";

function makeText(id: string): SnapElement {
  return { type: "text", props: { content: id } };
}

function makeStack(children: string[]): SnapElement {
  return { type: "stack", props: {}, children };
}

function baseResponse(
  elements: Record<string, SnapElement>,
  root = "root",
): SnapResponse {
  return {
    version: "2.0",
    ui: { root, elements },
  };
}

describe("validateSnapStructure (snap v2)", () => {
  it("accepts a small well-formed tree", () => {
    const elements: Record<string, SnapElement> = {
      root: makeStack(["a", "b"]),
      a: makeText("a"),
      b: makeText("b"),
    };
    expect(validateSnapStructure(baseResponse(elements))).not.toBeNull();
  });

  it("rejects > 64 total elements", () => {
    const elements: Record<string, SnapElement> = {};
    const childIds: string[] = [];
    // 1 root + 6 containers * 11 children each = 67 elements, but also
    // honor the 7-root-children / 6-container-children limits below.
    // Simpler: produce a flat root with 7 stacks, each holding 9 texts
    // → 1 + 7 + 63 = 71 elements, total >64, root children ok, but
    // container children 9 > 6. Instead ensure root has 7 stacks with 6
    // children each = 1 + 7 + 42 = 50. Too few. Use extra levels.
    for (let i = 0; i < 65; i++) {
      const id = `t${i}`;
      elements[id] = makeText(id);
      childIds.push(id);
    }
    // root holds 65 children — violates both root-children and total count.
    elements.root = makeStack(childIds);
    expect(validateSnapStructure(baseResponse(elements))).toBeNull();
  });

  it("rejects nesting depth > 4", () => {
    // depth-5 chain: root (1) → s2 (2) → s3 (3) → s4 (4) → s5 (5)
    const elements: Record<string, SnapElement> = {
      root: makeStack(["s2"]),
      s2: makeStack(["s3"]),
      s3: makeStack(["s4"]),
      s4: makeStack(["s5"]),
      s5: makeText("s5"),
    };
    expect(validateSnapStructure(baseResponse(elements))).toBeNull();
  });

  it("rejects a container with 7 children (limit is 6)", () => {
    // root has 1 stack child (ok), stack has 7 text children (violates)
    const elements: Record<string, SnapElement> = {
      root: makeStack(["box"]),
      box: makeStack(["c0", "c1", "c2", "c3", "c4", "c5", "c6"]),
      c0: makeText("c0"),
      c1: makeText("c1"),
      c2: makeText("c2"),
      c3: makeText("c3"),
      c4: makeText("c4"),
      c5: makeText("c5"),
      c6: makeText("c6"),
    };
    expect(validateSnapStructure(baseResponse(elements))).toBeNull();
  });

  it("accepts root with 7 children (root limit is 7)", () => {
    const elements: Record<string, SnapElement> = {
      root: makeStack(["c0", "c1", "c2", "c3", "c4", "c5", "c6"]),
      c0: makeText("c0"),
      c1: makeText("c1"),
      c2: makeText("c2"),
      c3: makeText("c3"),
      c4: makeText("c4"),
      c5: makeText("c5"),
      c6: makeText("c6"),
    };
    expect(validateSnapStructure(baseResponse(elements))).not.toBeNull();
  });
});
