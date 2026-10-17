/**
 * Tests for the Farcaster-space cast embed renderer.
 *
 * Coverage:
 *   - Renders the Juke "Join Space" card when a cast embed URL matches
 *     `https://farcaster.xyz/~/spaces/<uuid>` and the room snapshot
 *     resolves via Juke's backend proxy.
 *   - Falls back (renders nothing — parent renders generic link card)
 *     when `fetchFarcasterNativeSpace` returns null.
 *   - Tap mirrors the upstream space into Juke and routes to the in-app
 *     player. Web deep-link only fires when mirror throws (fallback).
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import React from "react";

// -- expo-image: render a plain View so we don't need native plumbing.
jest.mock("expo-image", () => {
  const rn = jest.requireActual("react-native") as { View: unknown };
  return { Image: rn.View };
});

// -- expo-router: stub useRouter
const mockPush = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush, replace: mockPush }),
}));

// -- @expo/vector-icons
jest.mock("@expo/vector-icons", () => {
  const rn = jest.requireActual("react-native") as { View: unknown };
  return { Ionicons: rn.View };
});

import { Linking } from "react-native";
const mockOpenURL = jest
  .spyOn(Linking, "openURL")
  .mockImplementation(async (_url: string) => true);

// -- api: mock both the snapshot fetch and the mirror call.
const mockFetchFarcasterNativeSpace =
  jest.fn<(id: string) => Promise<unknown>>();
const mockMirrorNativeRoom = jest.fn<(body: unknown) => Promise<unknown>>();
jest.mock("@/services/api", () => ({
  fetchFarcasterNativeSpace: (id: string) => mockFetchFarcasterNativeSpace(id),
  mirrorNativeRoom: (body: unknown) => mockMirrorNativeRoom(body),
}));

// -- Theme hooks (skip styling concerns)
jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    colors: {
      accent: "#000",
      purple: "#000",
      text: { primary: "#000", secondary: "#000", body: "#000", light: "#000" },
      background: { border: "#000", subtle: "#000" },
    },
    glass: {},
  }),
}));
jest.mock("@/hooks/useThemedStyles", () => ({
  useThemedStyles: (factory: (t: unknown) => unknown) =>
    factory({
      colors: {
        accent: "#000",
        purple: "#000",
        text: {
          primary: "#000",
          secondary: "#000",
          body: "#000",
          light: "#000",
        },
        background: { border: "#000", subtle: "#000" },
      },
      glass: {},
    }),
}));

import { FarcasterSpaceEmbedCard } from "@/components/feed/FarcasterSpaceEmbedCard";

const SPACE_ID = "019e7436-9abf-6395-ff65-c6eb7b3a8d89";

// `FarcasterNativeSpace` shape — snake_case, mirrors what the backend
// proxy returns (model_dump uses field names, not aliases).
const sampleSpace = {
  id: SPACE_ID,
  title: "Builders Hour",
  state: "live" as const,
  started_at: "2026-06-10T18:00:00+00:00",
  host: {
    fid: 42,
    username: "alice",
    display_name: "Alice",
    pfp_url: "https://example.com/alice.png",
  },
  listener_count: 7,
};

function resetAll() {
  mockPush.mockReset();
  mockOpenURL.mockReset();
  mockFetchFarcasterNativeSpace.mockReset();
  mockMirrorNativeRoom.mockReset();
}

describe("FarcasterSpaceEmbedCard", () => {
  beforeEach(() => {
    resetAll();
  });

  it("renders the Juke Space card when the room resolves", async () => {
    mockFetchFarcasterNativeSpace.mockResolvedValueOnce(sampleSpace);
    const onFallback = jest.fn();

    const { getByText } = render(
      <FarcasterSpaceEmbedCard spaceId={SPACE_ID} onFallback={onFallback} />,
    );

    await waitFor(() => {
      expect(getByText("Builders Hour")).toBeTruthy();
    });
    expect(getByText("Join")).toBeTruthy();
    expect(getByText("LIVE")).toBeTruthy();
    expect(getByText("7 listening")).toBeTruthy();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("falls back when fetchFarcasterNativeSpace returns null", async () => {
    mockFetchFarcasterNativeSpace.mockResolvedValueOnce(null);
    const onFallback = jest.fn();

    render(
      <FarcasterSpaceEmbedCard spaceId={SPACE_ID} onFallback={onFallback} />,
    );

    await waitFor(() => {
      expect(onFallback).toHaveBeenCalled();
    });
  });

  it("tap mirrors the space and routes to the in-app Juke player", async () => {
    mockFetchFarcasterNativeSpace.mockResolvedValueOnce(sampleSpace);
    mockMirrorNativeRoom.mockResolvedValueOnce({ id: "juke-room-uuid" });

    const { getByLabelText } = render(
      <FarcasterSpaceEmbedCard spaceId={SPACE_ID} />,
    );

    const pressable = await waitFor(() =>
      getByLabelText(/Join Builders Hour on Farcaster/),
    );
    fireEvent.press(pressable);

    await waitFor(() => {
      expect(mockMirrorNativeRoom).toHaveBeenCalledWith(
        expect.objectContaining({
          farcaster_room_id: SPACE_ID,
          title: "Builders Hour",
          host_fid: 42,
          host_username: "alice",
          host_display_name: "Alice",
          host_pfp_url: "https://example.com/alice.png",
        }),
      );
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/space/juke-room-uuid");
    });
    expect(mockOpenURL).not.toHaveBeenCalled();
  });

  it("tap falls back to a web deep-link when mirror fails", async () => {
    mockFetchFarcasterNativeSpace.mockResolvedValueOnce(sampleSpace);
    mockMirrorNativeRoom.mockRejectedValueOnce(new Error("mirror 500"));

    const { getByLabelText } = render(
      <FarcasterSpaceEmbedCard spaceId={SPACE_ID} />,
    );

    const pressable = await waitFor(() =>
      getByLabelText(/Join Builders Hour on Farcaster/),
    );
    fireEvent.press(pressable);

    await waitFor(() => {
      expect(mockOpenURL).toHaveBeenCalledWith(
        `https://farcaster.xyz/~/spaces/${SPACE_ID}`,
      );
    });
    expect(mockPush).not.toHaveBeenCalled();
  });
});
