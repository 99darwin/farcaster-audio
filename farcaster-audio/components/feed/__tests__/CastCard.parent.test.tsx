import React from "react";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render } from "@testing-library/react-native";
import { CastCard } from "../CastCard";
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

jest.mock("@/services/api", () => ({
  getUserByUsername: jest.fn(),
}));

const PARENT_HASH = "0xparent";

function makeCast(overrides: Partial<FarcasterCast> = {}): FarcasterCast {
  return {
    hash: "0xreply",
    author: {
      fid: 4167,
      username: "nounishprof",
      display_name: "Nounish Prof",
      pfp_url: null,
    },
    text: "well hello there old friend",
    timestamp: new Date().toISOString(),
    reactions: { likes_count: 0, recasts_count: 0, likes: [], recasts: [] },
    replies: { count: 0 },
    thread_hash: PARENT_HASH,
    parent_hash: PARENT_HASH,
    parent_cast: {
      hash: PARENT_HASH,
      author: { fid: 758919, username: "mazmhussain", display_name: "Murtaza" },
      text: "the original thought",
      timestamp: new Date().toISOString(),
    },
    ...overrides,
  } as FarcasterCast;
}

function renderCard(cast: FarcasterCast, threaded = false) {
  return render(
    <CastCard
      cast={cast}
      myFid={1}
      onLike={jest.fn()}
      onRecast={jest.fn()}
      onBookmark={jest.fn()}
      onQuoteCast={jest.fn()}
      onReply={jest.fn()}
      threaded={threaded}
    />,
  );
}

describe("CastCard parent context", () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it("shows the parent cast above a reply and opens it on press", () => {
    const { getByText, getByLabelText } = renderCard(makeCast());

    expect(getByText("the original thought")).toBeTruthy();
    expect(getByText("@mazmhussain")).toBeTruthy();

    fireEvent.press(
      getByLabelText("Replying to Murtaza: the original thought"),
    );
    expect(mockPush).toHaveBeenCalledWith(`/cast/${PARENT_HASH}`);
  });

  it("omits parent context when none was attached", () => {
    const { queryByText } = renderCard(makeCast({ parent_cast: null }));

    expect(queryByText("the original thought")).toBeNull();
  });

  it("omits parent context inside thread views", () => {
    const { queryByText } = renderCard(makeCast(), true);

    expect(queryByText("the original thought")).toBeNull();
  });
});
