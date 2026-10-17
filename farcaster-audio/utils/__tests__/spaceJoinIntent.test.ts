import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  SPACE_JOIN_INTENT_TTL_MS,
  buildJoinSpaceConfirmation,
  consumeSpaceJoinIntent,
  markSpaceJoinIntent,
} from "@/utils/spaceJoinIntent";

describe("space join intent", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-10-17T12:00:00Z") });
    consumeSpaceJoinIntent("room-a");
    consumeSpaceJoinIntent("room-b");
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("is absent for a deep-linked room", () => {
    expect(consumeSpaceJoinIntent("room-a")).toBe(false);
  });

  it("is consumed once for the tapped room", () => {
    markSpaceJoinIntent("room-a");
    expect(consumeSpaceJoinIntent("room-a")).toBe(true);
    expect(consumeSpaceJoinIntent("room-a")).toBe(false);
  });

  it("does not carry over to a different room", () => {
    markSpaceJoinIntent("room-a");
    expect(consumeSpaceJoinIntent("room-b")).toBe(false);
    expect(consumeSpaceJoinIntent("room-a")).toBe(true);
  });

  it("expires after the TTL", () => {
    markSpaceJoinIntent("room-a");
    jest.advanceTimersByTime(SPACE_JOIN_INTENT_TTL_MS + 1);
    expect(consumeSpaceJoinIntent("room-a")).toBe(false);
  });
});

describe("buildJoinSpaceConfirmation", () => {
  it("names the host and shows the room title", () => {
    const request = buildJoinSpaceConfirmation({
      title: "  Friday jam ",
      host: { display_name: "Alice", username: "alice" } as never,
    });
    expect(request.message).toContain("Alice");
    expect(request.detail).toBe("Friday jam");
    expect(request.confirmLabel).toBe("Join space");
  });

  it("falls back gracefully without host or title", () => {
    const request = buildJoinSpaceConfirmation({ title: "", host: undefined as never });
    expect(request.message).toContain("a live space");
    expect(request.detail).toBeUndefined();
  });
});
