import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { FeedList } from "../FeedList";
import type { FarcasterCast } from "@/types/farcaster";

const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/components/feed/CastActions", () => ({
  CastActions: () => null,
}));

jest.mock("@/components/feed/OgPreview", () => ({
  OgPreview: () => null,
}));

jest.mock("@/components/common/ImageViewer", () => ({
  MediaViewer: () => null,
}));

jest.mock("@/components/feed/VideoPlayer", () => ({
  VideoPlayer: () => null,
}));

jest.mock("@/components/voice-notes/VoiceNoteFeedItem", () => ({
  VoiceNoteFeedItem: () => null,
}));

jest.mock("@/services/api", () => ({
  getUserByUsername: jest.fn(),
}));

function makeCast(
  hash: string,
  text: string,
  overrides: Partial<FarcasterCast> = {},
): FarcasterCast {
  return {
    hash,
    author: { fid: 7, username: "op", display_name: "Op", pfp_url: null },
    text,
    timestamp: new Date().toISOString(),
    reactions: { likes_count: 0, recasts_count: 0, likes: [], recasts: [] },
    replies: { count: 0 },
    thread_hash: null,
    parent_hash: null,
    ...overrides,
  } as FarcasterCast;
}

function renderFeed(cast: FarcasterCast) {
  return render(
    <FeedList
      items={[{ type: "cast", data: cast }]}
      myFid={1}
      isLoading={false}
      isRefreshing={false}
      hasMore={false}
      onRefresh={jest.fn()}
      onEndReached={jest.fn()}
      onLike={jest.fn()}
      onRecast={jest.fn()}
      onBookmark={jest.fn()}
      onQuoteCast={jest.fn()}
      onReply={jest.fn()}
    />,
  );
}

describe("FeedList conversations", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("renders a full parent as a post connected above the reply", () => {
    const parent = makeCast("0xparent", "the original thought");
    const reply = makeCast("0xreply", "a reply", {
      parent_hash: parent.hash,
      parent_cast: parent,
    });

    const { getByText, getByTestId, queryByLabelText } = renderFeed(reply);

    expect(getByText("the original thought")).toBeTruthy();
    expect(getByText("a reply")).toBeTruthy();
    expect(getByTestId("thread-line-below")).toBeTruthy();
    expect(getByTestId("thread-line-above")).toBeTruthy();
    expect(queryByLabelText(/^Replying to/)).toBeNull();

    fireEvent.press(getByText("the original thought"));
    expect(mockPush).toHaveBeenCalledWith("/cast/0xparent");
  });

  it("falls back to the inline preview for a legacy parent", () => {
    const reply = makeCast("0xreply", "a reply", {
      parent_hash: "0xparent",
      parent_cast: {
        hash: "0xparent",
        author: { fid: 7, username: "op", display_name: "Op" },
        text: "the original thought",
      },
    });

    const { getByLabelText, queryByTestId } = renderFeed(reply);

    expect(getByLabelText("Replying to Op: the original thought")).toBeTruthy();
    expect(queryByTestId("thread-line-above")).toBeNull();
  });
});
