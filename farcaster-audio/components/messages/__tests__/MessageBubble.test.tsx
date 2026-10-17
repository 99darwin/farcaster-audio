import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { MessageBubble, type MessageBubbleProps } from "@/components/messages/MessageBubble";
import { ALICE, makeMessage, VIEWER } from "@/components/messages/__fixtures__/messages";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));

const mockMedium = jest.fn();
jest.mock("@/utils/haptics", () => ({
  haptic: { medium: () => mockMedium(), selection: jest.fn(), success: jest.fn() },
}));

function renderBubble(overrides: Partial<MessageBubbleProps> = {}) {
  const props: MessageBubbleProps = {
    message: makeMessage({ message_id: "m1", sender: ALICE, text: "hello" }),
    isOwn: false,
    isGroup: false,
    isRunStart: true,
    isRunEnd: true,
    isHighlighted: false,
    isSeen: false,
    onLongPress: jest.fn(),
    onDoubleTap: jest.fn(),
    onQuotePress: jest.fn(),
    onReactionChipPress: jest.fn(),
    onRetry: jest.fn(),
    onReply: jest.fn(),
    onSenderPress: jest.fn(),
    onMentionPress: jest.fn(),
    ...overrides,
  };
  return { ...render(<MessageBubble {...props} />), props };
}

describe("MessageBubble", () => {
  beforeEach(() => {
    mockMedium.mockClear();
    jest.spyOn(Date, "now").mockReturnValue(1_000);
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("ignores long press on deleted messages", () => {
    const message = makeMessage({ message_id: "m1", is_deleted: true });
    const { getByTestId, props } = renderBubble({ message });
    fireEvent(getByTestId("bubble-m1"), "longPress");
    expect(props.onLongPress).not.toHaveBeenCalled();
    expect(mockMedium).not.toHaveBeenCalled();
  });

  it("fires a haptic on long press", () => {
    const { getByTestId } = renderBubble();
    fireEvent(getByTestId("bubble-m1"), "longPress");
    expect(mockMedium).toHaveBeenCalledTimes(1);
  });

  it("highlights exact search ranges over terms", () => {
    const message = makeMessage({ message_id: "m1", sender: ALICE, text: "flat white" });
    const { getByText } = renderBubble({
      message,
      highlightTerms: ["flat"],
      highlightRanges: [{ start: 5, end: 10 }],
    });
    // Untrimmed matching: ranges split "flat |white"; terms would split "flat| white".
    const exact = { normalizer: (text: string) => text };
    expect(getByText("flat ", exact)).toBeTruthy();
    expect(getByText("white", exact)).toBeTruthy();
    expect(() => getByText(" white", exact)).toThrow();
  });

  it("reacts on a double tap within the window only", () => {
    const now = jest.spyOn(Date, "now");
    const { getByTestId, props } = renderBubble();
    const bubble = getByTestId("bubble-m1");

    now.mockReturnValue(1_000);
    fireEvent.press(bubble);
    now.mockReturnValue(2_000);
    fireEvent.press(bubble);
    expect(props.onDoubleTap).not.toHaveBeenCalled();

    now.mockReturnValue(2_100);
    fireEvent.press(bubble);
    expect(props.onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it("jumps to the quoted message", () => {
    const message = makeMessage({
      message_id: "m2",
      in_reply_to: { message_id: "q1", sender: VIEWER, text: "original", is_deleted: false },
    });
    const { getByTestId, props } = renderBubble({ message });
    fireEvent.press(getByTestId("quote-q1"));
    expect(props.onQuotePress).toHaveBeenCalledWith("q1");
  });

  it("opens reactors from a chip", () => {
    const message = makeMessage({
      message_id: "m3",
      reactions: [{ reaction: "👍", count: 2, viewer_reacted: false }],
    });
    const { getByTestId, props } = renderBubble({ message });
    fireEvent.press(getByTestId("reaction-chip-👍"));
    expect(props.onReactionChipPress).toHaveBeenCalledWith(message, "👍");
  });

  it("retries a failed send on tap and blocks the overlay", () => {
    const message = makeMessage({ message_id: "m4", sender: VIEWER, send_state: "failed" });
    const { getByTestId, getByText, props } = renderBubble({ message, isOwn: true });
    fireEvent.press(getByTestId("bubble-m4"));
    fireEvent(getByTestId("bubble-m4"), "longPress");
    expect(props.onRetry).toHaveBeenCalledWith(message);
    expect(props.onLongPress).not.toHaveBeenCalled();
    expect(getByText("Not delivered · Tap to retry")).toBeTruthy();
  });

  it("shows Seen and the deleted placeholder", () => {
    const message = makeMessage({ message_id: "m5", is_deleted: true, text: "secret" });
    const { getByText, queryByText } = renderBubble({ message, isOwn: true, isSeen: true });
    expect(getByText("Message deleted")).toBeTruthy();
    expect(getByText("Seen")).toBeTruthy();
    expect(queryByText("secret")).toBeNull();
  });
});
