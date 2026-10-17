import React from "react";
import { Alert } from "react-native";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import MessagesScreen from "../messages";
import { MessagesApiError } from "@/services/messagesApi";
import { useMessageStore } from "@/stores/messageStore";
import { makeConversation } from "@/components/messages/__fixtures__/messages";
import type { Conversation } from "@/types/messages";

const mockPush = jest.fn();
const mockRefresh = jest.fn<() => Promise<void>>(async () => undefined);
const mockToggleUnread = jest.fn<(c: Conversation) => Promise<void>>(async () => undefined);
const mockUseInbox = jest.fn();
let mockConversations: Conversation[] = [];
let mockErrorCode: string | null = null;
let mockTabPress: (() => void) | null = null;

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useNavigation: () => ({
    addListener: (type: string, listener: () => void) => {
      if (type === "tabPress") mockTabPress = listener;
      return () => undefined;
    },
  }),
}));
jest.mock("@/services/snapSigner", () => ({ signFarcasterClientBearer: jest.fn() }));
jest.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }),
}));
jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@/components/navigation/GlassTabBar", () => ({ TAB_BAR_CONTENT_INSET: 80 }));
jest.mock("@/stores/authStore", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { fid: 1 } }),
}));
jest.mock("@/hooks/useMessagingAccess", () => ({
  useMessagingAccess: () => ({
    state: "ready",
    enableReason: null,
    expiresAt: null,
    isEnabling: false,
    enableError: null,
    enable: jest.fn(),
    refresh: jest.fn(),
    clearEnableError: jest.fn(),
  }),
}));
jest.mock("@/hooks/useInbox", () => ({
  useInbox: (options: unknown) => {
    mockUseInbox(options);
    return {
      conversations: mockConversations,
      isLoading: false,
      isRefreshing: false,
      isLoadingMore: false,
      hasMore: false,
      hasLoaded: true,
      errorCode: mockErrorCode,
      refresh: mockRefresh,
      loadMore: jest.fn(),
      toggleUnread: mockToggleUnread,
    };
  },
}));
// The real row uses ReanimatedSwipeable, which needs native worklets.
jest.mock("@/components/messages/ConversationRow", () => {
  const React = require("react");
  const { Pressable, Text } = require("react-native");
  return {
    ConversationRow: ({ conversation, onPress, onToggleUnread }: any) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          Pressable,
          { testID: `conversation-${conversation.conversation_id}`, onPress: () => onPress(conversation) },
          React.createElement(Text, null, conversation.conversation_id),
        ),
        React.createElement(Pressable, {
          testID: `toggle-${conversation.conversation_id}`,
          onPress: () => onToggleUnread(conversation),
        }),
      ),
  };
});

describe("Messages inbox", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversations = [];
    mockErrorCode = null;
    mockTabPress = null;
    useMessageStore.setState({
      availability: "available",
      requestsCount: 0,
      hasUnreadRequests: false,
    });
  });

  it("opens a conversation on tap", () => {
    mockConversations = [makeConversation({ conversation_id: "c1" })];
    const screen = render(<MessagesScreen />);
    fireEvent.press(screen.getByTestId("conversation-c1"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/messages/[conversationId]",
      params: { conversationId: "c1" },
    });
  });

  it("alerts when toggling unread fails", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
    mockConversations = [makeConversation({ conversation_id: "c1" })];
    mockToggleUnread.mockRejectedValueOnce(new MessagesApiError("rate_limited", 429));
    const screen = render(<MessagesScreen />);
    fireEvent.press(screen.getByTestId("toggle-c1"));
    await waitFor(() => expect(alert).toHaveBeenCalledWith("Couldn't update", expect.any(String)));
  });

  it("switches to requests and shows its counts", () => {
    useMessageStore.setState({ requestsCount: 3, hasUnreadRequests: true });
    const screen = render(<MessagesScreen />);
    expect(screen.getByTestId("requests-unread-dot")).toBeTruthy();
    expect(screen.getByTestId("inbox-empty")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Requests (3)"));
    expect(mockUseInbox).toHaveBeenLastCalledWith(
      expect.objectContaining({ segment: "request", isEnabled: true }),
    );
    expect(screen.getByTestId("inbox-empty-requests")).toBeTruthy();
    expect(screen.queryByTestId("requests-unread-dot")).toBeNull();
  });

  it("shows an error with retry and refreshes on tab re-press", () => {
    mockErrorCode = "network";
    const screen = render(<MessagesScreen />);
    expect(screen.getByTestId("inbox-error")).toBeTruthy();
    fireEvent.press(screen.getByText("Try again"));
    expect(mockRefresh).toHaveBeenCalledTimes(1);

    act(() => mockTabPress?.());
    expect(mockRefresh).toHaveBeenCalledTimes(2);
  });

  it("shows the feature-off state instead of the inbox", () => {
    useMessageStore.setState({ availability: "unavailable" });
    const screen = render(<MessagesScreen />);
    expect(screen.getByTestId("messages-unavailable")).toBeTruthy();
    expect(screen.queryByTestId("inbox-list")).toBeNull();
  });
});
