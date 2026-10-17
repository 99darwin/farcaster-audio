import { createScrollMemory } from "@/lib/messages/scroll-memory";

describe("createScrollMemory", () => {
  it("saves, recalls and forgets per conversation", () => {
    const memory = createScrollMemory();
    memory.save("a", { kind: "anchor", anchor: { key: "m:1", delta: 12 } });
    memory.save("b", { kind: "bottom" });
    expect(memory.recall("a")).toEqual({ kind: "anchor", anchor: { key: "m:1", delta: 12 } });
    expect(memory.recall("b")).toEqual({ kind: "bottom" });
    memory.forget("a");
    expect(memory.recall("a")).toBeNull();
    memory.clear();
    expect(memory.recall("b")).toBeNull();
  });

  it("drops the least recently saved past the limit", () => {
    const memory = createScrollMemory(2);
    memory.save("a", { kind: "bottom" });
    memory.save("b", { kind: "bottom" });
    memory.save("a", { kind: "bottom" });
    memory.save("c", { kind: "bottom" });
    expect(memory.recall("b")).toBeNull();
    expect(memory.recall("a")).not.toBeNull();
    expect(memory.recall("c")).not.toBeNull();
  });
});
