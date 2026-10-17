import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";

const mockAddReaction = jest.fn<(body: unknown) => Promise<void>>();

jest.mock("@/services/messagesApi", () => {
  const actual = jest.requireActual("@/services/messagesApi") as Record<string, unknown>;
  return {
    ...actual,
    addReaction: (body: unknown) => mockAddReaction(body),
    removeReaction: async () => undefined,
  };
});
jest.mock("@/services/storage", () => ({ getTokens: async () => null }));
jest.mock("@/services/authRefresh", () => ({ refreshSession: async () => true }));
jest.mock("@/utils/haptics", () => ({ haptic: { selection: () => undefined } }));

import { useMessageReactions } from "@/hooks/useMessageReactions";
import { MessagesApiError } from "@/services/messagesApi";
import { useMessageStore } from "@/stores/messageStore";
import { makeMessage } from "@/components/messages/__fixtures__/messages";

const MESSAGE = makeMessage({ message_id: "m1", reactions: [] });

describe("useMessageReactions", () => {
  beforeEach(() => {
    useMessageStore.getState().reset();
    useMessageStore
      .getState()
      .setThreadPage("c1", { items: [MESSAGE], next_cursor: null, next_newer_cursor: null }, "replace");
    mockAddReaction.mockReset();
  });

  it("reverts and surfaces Farcaster's reason on upstream_rejected", async () => {
    mockAddReaction.mockRejectedValue(
      new MessagesApiError("upstream_rejected", 422, "Reactions are limited"),
    );
    const { result } = renderHook(() => useMessageReactions("c1"));
    let errorMessage: string | null = null;
    await act(async () => {
      errorMessage = await result.current.toggleReaction(MESSAGE, "👍");
    });
    expect(errorMessage).toBe("Farcaster rejected this message. Reactions are limited");
    expect(useMessageStore.getState().threads.c1.messages[0].reactions).toEqual([]);
  });

  it("resolves null on success", async () => {
    mockAddReaction.mockResolvedValue(undefined);
    const { result } = renderHook(() => useMessageReactions("c1"));
    let errorMessage: string | null = "unset";
    await act(async () => {
      errorMessage = await result.current.toggleReaction(MESSAGE, "👍");
    });
    expect(errorMessage).toBeNull();
  });
});
