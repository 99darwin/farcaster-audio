import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react-native";
import type { SendMessageRequest, SendMessageResponse } from "@/types/messages";

const mockSendMessage = jest.fn<(body: SendMessageRequest) => Promise<SendMessageResponse>>();

jest.mock("@/services/messagesApi", () => {
  const actual = jest.requireActual("@/services/messagesApi") as Record<string, unknown>;
  return { ...actual, sendMessage: (body: SendMessageRequest) => mockSendMessage(body) };
});
jest.mock("expo-crypto", () => ({ randomUUID: () => "m-new" }));
jest.mock("@/utils/haptics", () => ({ haptic: { light: jest.fn(), error: jest.fn() } }));
jest.mock("@/services/storage", () => ({ getTokens: async () => null }));
jest.mock("@/services/authRefresh", () => ({ refreshSession: async () => true }));

import { useSendMessage } from "@/hooks/useSendMessage";
import { MessagesApiError } from "@/services/messagesApi";
import { useMessageStore } from "@/stores/messageStore";
import { VIEWER } from "@/components/messages/__fixtures__/messages";

describe("useSendMessage upstream_rejected", () => {
  beforeEach(() => {
    useMessageStore.getState().reset();
    mockSendMessage.mockReset();
  });

  it("shows Farcaster's reason, marks the row failed, and does not resend", async () => {
    mockSendMessage.mockRejectedValue(
      new MessagesApiError("upstream_rejected", 422, "Recipient blocks DMs"),
    );
    const { result } = renderHook(() =>
      useSendMessage({ threadKey: "c1", conversationId: "c1", recipientFid: null, viewer: VIEWER }),
    );
    let outcome: Awaited<ReturnType<typeof result.current.send>> | undefined;
    await act(async () => {
      outcome = await result.current.send("hello", null);
    });
    expect(outcome).toEqual({
      isSent: false,
      errorMessage: "Farcaster rejected this message. Recipient blocks DMs",
    });
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(useMessageStore.getState().threads.c1.messages[0]).toMatchObject({
      message_id: "m-new",
      send_state: "failed",
    });
    expect(useMessageStore.getState().availability).not.toBe("unavailable");
  });
});
