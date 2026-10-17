/**
 * Tests for the native-room host screen
 * (`app/space/host/[id].tsx`).
 *
 * Coverage:
 *   - Renders the room title, "Hosted on Farcaster as @{username}"
 *     subtitle, and the Live state pill on a live room.
 *   - "Open on Farcaster" CTA deep-links to farcaster.xyz with the
 *     upstream `farcaster_room_id`.
 *   - "End Space" CTA prompts a confirmation and dispatches
 *     `api.endFarcasterNativeRoom` on confirm; navigates home on
 *     success.
 *   - Ended state hides the End / Open-on-Farcaster CTAs (only the
 *     Done button remains).
 *
 * We deliberately do NOT mock the real theme / Button / LoadingSpinner
 * / authStore — jest-expo wires them sufficiently for headless render,
 * and over-mocking can produce render-phase exceptions that surface as
 * a misleading `window.dispatchEvent is not a function` from
 * react-test-renderer's global-error reporter.
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import React from "react";

// expo-router — capture navigation + params.
const mockReplace = jest.fn();
let mockParams: { id?: string } = { id: "juke-room-id" };
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: mockReplace, push: mockReplace }),
  useLocalSearchParams: () => mockParams,
}));

// @expo/vector-icons — render as plain Views.
jest.mock("@expo/vector-icons", () => {
  const rn = jest.requireActual("react-native") as { View: unknown };
  return { Ionicons: rn.View };
});

// react-native-toast-message
const mockToastShow = jest.fn();
jest.mock("react-native-toast-message", () => ({
  __esModule: true,
  default: { show: (...args: unknown[]) => mockToastShow(...args) },
}));

// react-native-safe-area-context
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// snapSigner: stub the JFS bearer signer so we don't need
// expo-secure-store / ed25519 plumbing in the test environment.
const mockSignFarcasterClientBearer =
  jest.fn<(fid: number) => Promise<string>>();
jest.mock("@/services/snapSigner", () => ({
  signFarcasterClientBearer: (fid: number) =>
    mockSignFarcasterClientBearer(fid),
}));

// services/api
const mockGetRoom = jest.fn<(id: string) => Promise<unknown>>();
const mockEndFarcasterNativeRoom = jest.fn<
  (id: string, body?: { user_jfs_bearer?: string }) => Promise<unknown>
>();
jest.mock("@/services/api", () => ({
  getRoom: (id: string) => mockGetRoom(id),
  endFarcasterNativeRoom: (
    id: string,
    body?: { user_jfs_bearer?: string },
  ) => mockEndFarcasterNativeRoom(id, body),
  getErrorMessage: () => "Something went wrong",
}));

// ---------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------

import { Alert, Linking } from "react-native";
import HostScreen from "../[id]";
import { useAuthStore } from "@/stores/authStore";

const mockOpenURL = jest
  .spyOn(Linking, "openURL")
  .mockImplementation(async () => true);

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

interface RoomFixture {
  id: string;
  title: string;
  host_fid: number;
  host: { fid: number; username: string; display_name: string; pfp_url: null };
  status: string;
  started_at: string;
  ended_at: string | null;
  scheduled_at: null;
  speaker_count: number;
  listener_count: number;
  recording: boolean;
  cast_hash: null;
  farcaster_room_id: string;
  is_farcaster_native: true;
}

function makeRoom(overrides: Partial<RoomFixture> = {}): RoomFixture {
  return {
    id: "juke-room-id",
    title: "My Native Space",
    host_fid: 999,
    host: {
      fid: 999,
      username: "alice",
      display_name: "Alice",
      pfp_url: null,
    },
    status: "active",
    started_at: new Date().toISOString(),
    ended_at: null,
    scheduled_at: null,
    speaker_count: 0,
    listener_count: 0,
    recording: false,
    cast_hash: null,
    farcaster_room_id: "fc-room-uuid-from-upstream",
    is_farcaster_native: true,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams = { id: "juke-room-id" };
  mockOpenURL.mockResolvedValue(true);
  mockSignFarcasterClientBearer.mockResolvedValue(
    "aGVhZGVy.cGF5bG9hZA.c2lnbmF0dXJl",
  );
  // Seed the auth store with the room host so handleEnd can read fid
  // and sign the JFS bearer. Without this, user is null and the test
  // sends `user_jfs_bearer: undefined`.
  useAuthStore.setState({
    user: {
      fid: 999,
      username: "alice",
      display_name: "Alice",
      pfp_url: null,
      custody_address: "",
      is_pro: false,
      is_admin: false,
    },
  });
});

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

describe("HostScreen — live state", () => {
  it("renders the room title, host attribution, and Open on Farcaster CTA", async () => {
    mockGetRoom.mockResolvedValue({
      room: makeRoom(),
      participants: [],
      hand_queue: [],
    });

    const { findByText } = render(<HostScreen />);

    expect(await findByText("My Native Space")).toBeTruthy();
    expect(await findByText("Hosted on Farcaster as @alice")).toBeTruthy();
    expect(await findByText("Open on Farcaster")).toBeTruthy();
    expect(await findByText("End Space")).toBeTruthy();
    expect(await findByText("Live")).toBeTruthy();
  });

  it("Open on Farcaster deep-links to farcaster.xyz with the upstream room id", async () => {
    mockGetRoom.mockResolvedValue({
      room: makeRoom(),
      participants: [],
      hand_queue: [],
    });

    const { findByText } = render(<HostScreen />);
    const cta = await findByText("Open on Farcaster");
    fireEvent.press(cta);

    await waitFor(() =>
      expect(mockOpenURL).toHaveBeenCalledWith(
        "https://farcaster.xyz/~/spaces/fc-room-uuid-from-upstream",
      ),
    );
  });

  it("End Space confirms then dispatches endFarcasterNativeRoom + navigates home", async () => {
    mockGetRoom.mockResolvedValue({
      room: makeRoom(),
      participants: [],
      hand_queue: [],
    });
    mockEndFarcasterNativeRoom.mockResolvedValueOnce(
      makeRoom({
        status: "ended",
        ended_at: new Date().toISOString(),
      }),
    );

    // Auto-confirm: press the destructive button in the alert.
    const alertSpy = jest
      .spyOn(Alert, "alert")
      .mockImplementation((_title, _msg, buttons) => {
        const destructive = buttons?.find((b) => b.style === "destructive");
        destructive?.onPress?.();
      });

    const { findByText } = render(<HostScreen />);
    const cta = await findByText("End Space");
    fireEvent.press(cta);

    await waitFor(() =>
      expect(mockEndFarcasterNativeRoom).toHaveBeenCalledWith(
        "juke-room-id",
        expect.objectContaining({ user_jfs_bearer: expect.any(String) }),
      ),
    );
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/"));

    alertSpy.mockRestore();
  });
});

describe("HostScreen — ended state", () => {
  it("hides End/Open CTAs when the room has already ended", async () => {
    mockGetRoom.mockResolvedValue({
      room: makeRoom({
        status: "ended",
        ended_at: new Date().toISOString(),
      }),
      participants: [],
      hand_queue: [],
    });

    const { findByText, queryByText } = render(<HostScreen />);
    // The Ended state pill is the cue the room has ended.
    expect(await findByText("Ended")).toBeTruthy();
    // The destructive CTA and the Open-on-Farcaster CTA are gone.
    expect(queryByText("End Space")).toBeNull();
    expect(queryByText("Open on Farcaster")).toBeNull();
    // The Done CTA remains.
    expect(await findByText("Done")).toBeTruthy();
  });
});
