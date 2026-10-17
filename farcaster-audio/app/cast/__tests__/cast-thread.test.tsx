import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import CastThreadScreen from "../[hash]";

const mockPush = jest.fn();
const mockFetch = jest.fn<() => Promise<void>>();
const mockScrollToIndex = jest.fn();
const mockUseCastThread = jest.fn();
const mockFindTopLevelIndexContaining = jest.fn<
  (replies: unknown[], hash: string) => number
>(() => 0);

let mockParams: {
  hash: string;
  focusHash?: string;
};
let mockReplies: Array<{ hash: string }>;
let mockAncestors: Array<{ hash: string; parent_hash?: string | null }>;

jest.mock("react-native", () => {
  const React = require("react");
  const actual = jest.requireActual(
    "react-native",
  ) as typeof import("react-native");

  const FlatList = React.forwardRef(
    (
      props: {
        data?: Array<{ hash: string }>;
        ListHeaderComponent?: React.ReactNode;
        renderItem?: (info: { item: { hash: string } }) => React.ReactNode;
        onContentSizeChange?: () => void;
      },
      ref: React.Ref<unknown>,
    ) => {
      React.useImperativeHandle(ref, () => ({
        scrollToIndex: mockScrollToIndex,
        scrollToOffset: jest.fn(),
      }));
      return React.createElement(
        actual.View,
        null,
        props.ListHeaderComponent,
        props.data?.map((item) =>
          React.createElement(
            React.Fragment,
            { key: item.hash },
            props.renderItem?.({ item }),
          ),
        ),
        React.createElement(actual.Pressable, {
          accessibilityLabel: "Simulate content layout",
          onPress: props.onContentSizeChange,
        }),
      );
    },
  );

  Object.defineProperty(actual, "FlatList", { value: FlatList });
  return actual;
});

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/stores/authStore", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { fid: 123 } }),
}));

jest.mock("@/stores/composeStore", () => ({
  useComposeStore: (selector: (state: unknown) => unknown) =>
    selector({ composeSignal: 0, draft: null, clearDraft: jest.fn() }),
}));

jest.mock("@/hooks/useCastThread", () => ({
  useCastThread: (hash: string, myFid: number) => {
    mockUseCastThread(hash, myFid);
    return {
      rootCast: { hash },
      ancestors: mockAncestors,
      replies: mockReplies,
      isLoading: false,
      error: null,
      fetch: mockFetch,
      updateCastReaction: jest.fn(),
      updateCastBookmark: jest.fn(),
    };
  },
}));

jest.mock("@/components/feed/CastCard", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    CastCard: ({
      cast,
      focal,
      connectAbove,
      connectBelow,
    }: {
      cast: { hash: string };
      focal?: boolean;
      connectAbove?: boolean;
      connectBelow?: boolean;
    }) =>
      React.createElement(
        Text,
        { testID: "cast-card" },
        [
          cast.hash,
          focal ? "focal" : "",
          connectAbove ? "above" : "",
          connectBelow ? "below" : "",
        ]
          .filter(Boolean)
          .join(" "),
      ),
  };
});
jest.mock("@/components/feed/ComposeModal", () => ({
  ComposeModal: () => null,
}));
jest.mock("@/components/common/LoadingSpinner", () => ({
  LoadingSpinner: () => null,
}));
jest.mock("@/components/common/ErrorView", () => ({ ErrorView: () => null }));

jest.mock("@/components/feed/ThreadedReplies", () => {
  const React = require("react");
  const { Text } = require("react-native");
  return {
    ThreadedReplies: ({ focusHash }: { focusHash?: string }) =>
      React.createElement(Text, { testID: "reply-focus-hash" }, focusHash),
    ThreadSlopFooter: () => null,
    findTopLevelIndexContaining: (replies: unknown[], hash: string) =>
      mockFindTopLevelIndexContaining(replies, hash),
    partitionSpamFromTree: (replies: Array<{ hash: string }>) => ({
      clean: replies,
      spam: [],
    }),
  };
});

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({ colors: { accent: "#fff" } }),
}));

jest.mock("@/hooks/useThemedStyles", () => ({
  useThemedStyles: (factory: (theme: unknown) => unknown) =>
    factory({
      colors: {
        background: { main: "#000", border: "#222" },
        text: { secondary: "#999" },
        purple: "#a855f7",
      },
    }),
}));

jest.mock("@/services/feed", () => ({
  likeCast: jest.fn(),
  recastCast: jest.fn(),
  removeLike: jest.fn(),
  removeRecast: jest.fn(),
  publishCast: jest.fn(),
}));

jest.mock("@/services/api", () => ({
  blockUser: jest.fn(),
  bookmarkCast: jest.fn(),
  removeBookmark: jest.fn(),
}));

describe("CastThreadScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { hash: "0xdead" };
    mockReplies = [];
    mockAncestors = [];
    mockFetch.mockResolvedValue(undefined);
  });

  it("renders ancestors inline above the focal cast, joined by thread lines", () => {
    mockAncestors = [
      { hash: "0xroot", parent_hash: null },
      { hash: "0xmid", parent_hash: "0xroot" },
    ];
    const screen = render(<CastThreadScreen />);

    expect(mockUseCastThread).toHaveBeenCalledWith("0xdead", 123);
    const cards = screen
      .getAllByTestId("cast-card")
      .map((card) => card.props.children);
    expect(cards).toEqual([
      "0xroot below",
      "0xmid above below",
      "0xdead focal above",
    ]);
    expect(screen.queryByLabelText("Show earlier replies")).toBeNull();
  });

  it("never shows a separate full-conversation link", () => {
    mockAncestors = [{ hash: "0xroot", parent_hash: null }];
    const screen = render(<CastThreadScreen />);

    expect(screen.queryByLabelText("View full conversation")).toBeNull();
  });

  it("renders a root cast as focal with no thread line above", () => {
    const screen = render(<CastThreadScreen />);

    expect(screen.getByTestId("cast-card").props.children).toBe("0xdead focal");
  });

  it("links to earlier replies when the ancestor chain is truncated", () => {
    mockAncestors = [{ hash: "0xmid", parent_hash: "0xolder" }];
    const screen = render(<CastThreadScreen />);

    fireEvent.press(screen.getByLabelText("Show earlier replies"));
    expect(mockPush).toHaveBeenCalledWith("/cast/0xolder");
  });

  it("uses the carried focus hash for full-thread scroll and highlighting", () => {
    mockParams = { hash: "0xbeef", focusHash: "0xdead" };
    mockReplies = [{ hash: "0xdead" }];
    const screen = render(<CastThreadScreen />);

    expect(screen.getByTestId("reply-focus-hash").props.children).toBe(
      "0xdead",
    );
    fireEvent.press(screen.getByLabelText("Simulate content layout"));

    expect(mockFindTopLevelIndexContaining).toHaveBeenCalledWith(
      mockReplies,
      "0xdead",
    );
    expect(mockScrollToIndex).toHaveBeenCalledWith({
      index: 0,
      animated: true,
      viewPosition: 0.05,
    });
  });
});
