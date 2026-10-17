/**
 * Tests for useFarcasterSync.
 *
 * Coverage:
 *   - enabled is false when no bearer is stored
 *   - enabled is true when bearer is present and fresh
 *   - expiringSoon surfaces correctly
 *   - revoke clears Keychain and calls DELETE /v1/farcaster-sync
 *   - revoke tolerates 404 from the backend
 *   - openMiniAppSync calls Linking.openURL with the constant
 */

import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react-native";

// --- SecureStore mock ---
const secureStore: Record<string, string> = {};

jest.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: "afterFirstUnlockThisDeviceOnly",
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "whenUnlockedThisDeviceOnly",
  getItemAsync: jest.fn(async (key: string) => {
    return Object.prototype.hasOwnProperty.call(secureStore, key)
      ? secureStore[key]
      : null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    secureStore[key] = value;
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    delete secureStore[key];
  }),
}));

// --- Linking mock ---
// Variables consumed inside `jest.mock()` factories must be prefixed with
// `mock` (case-insensitive) — Jest hoists the mock calls above imports, and
// any other captured name would be uninitialized at that point.
const mockOpenURL = jest.fn(async (_url: string) => {});
jest.mock("expo-linking", () => ({
  openURL: (url: string) => mockOpenURL(url),
}));

// --- apiClient mock (we only need .delete) ---
const mockApiDelete = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("@/services/api", () => ({
  apiClient: {
    delete: (...args: unknown[]) => mockApiDelete(...args),
  },
}));

import {
  __TEST_STORAGE_KEY__,
  type FarcasterBearer,
} from "@/services/farcasterBearer";
import { MINIAPP_SYNC_URL } from "@/constants/farcaster";
import { useFarcasterSync } from "@/hooks/useFarcasterSync";

const FID = 12345;
const SECRET = "test-secret";
// 40-hex-char EVM address (validated by farcasterBearer's isValidBearer).
const CUSTODY = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

function seedBearer(overrides: Partial<FarcasterBearer> = {}) {
  const bearer: FarcasterBearer = {
    secret: SECRET,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    custodyAddress: CUSTODY,
    fid: FID,
    ...overrides,
  };
  secureStore[__TEST_STORAGE_KEY__] = JSON.stringify(bearer);
  return bearer;
}

function resetAll() {
  for (const key of Object.keys(secureStore)) delete secureStore[key];
  mockOpenURL.mockClear();
  mockApiDelete.mockReset();
}

describe("useFarcasterSync", () => {
  beforeEach(() => {
    resetAll();
  });

  it("starts disabled when no bearer is stored", async () => {
    const { result } = renderHook(() => useFarcasterSync());

    // Initial render is empty snapshot.
    expect(result.current.enabled).toBe(false);
    expect(result.current.fid).toBeNull();
    expect(result.current.expiringSoon).toBe(false);

    // After hydration completes, still disabled.
    await waitFor(() => {
      expect(result.current.enabled).toBe(false);
    });
    expect(result.current.fid).toBeNull();
  });

  it("becomes enabled when a fresh bearer is present", async () => {
    seedBearer();
    const { result } = renderHook(() => useFarcasterSync());

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.fid).toBe(FID);
    expect(result.current.expiringSoon).toBe(false);
  });

  it("surfaces expiringSoon for a bearer near expiry", async () => {
    seedBearer({ expiresAt: Date.now() + 60 * 60 * 1000 }); // 1h out
    const { result } = renderHook(() => useFarcasterSync());

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });
    expect(result.current.expiringSoon).toBe(true);
  });

  it("treats an expired bearer as disabled and clears storage", async () => {
    seedBearer({ expiresAt: Date.now() - 1000 });
    const { result } = renderHook(() => useFarcasterSync());

    await waitFor(() => {
      // We don't currently track a "did hydrate" flag; assert the post-
      // hydration steady state via the storage side-effect.
      expect(secureStore[__TEST_STORAGE_KEY__]).toBeUndefined();
    });
    expect(result.current.enabled).toBe(false);
    expect(result.current.fid).toBeNull();
  });

  it("openMiniAppSync calls Linking.openURL with the constant", async () => {
    const { result } = renderHook(() => useFarcasterSync());
    await act(async () => {
      await result.current.openMiniAppSync();
    });
    expect(mockOpenURL).toHaveBeenCalledWith(MINIAPP_SYNC_URL);
  });

  it("revoke clears storage and calls DELETE /v1/farcaster-sync", async () => {
    seedBearer();
    mockApiDelete.mockResolvedValueOnce({});

    const { result } = renderHook(() => useFarcasterSync());
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });

    await act(async () => {
      await result.current.revoke();
    });

    expect(secureStore[__TEST_STORAGE_KEY__]).toBeUndefined();
    expect(mockApiDelete).toHaveBeenCalledWith("/v1/farcaster-sync");
    expect(result.current.enabled).toBe(false);
    expect(result.current.fid).toBeNull();
  });

  it("revoke tolerates a 404 from the backend", async () => {
    seedBearer();
    // Shape mimics axios error so axios.isAxiosError() returns true.
    const err = Object.assign(new Error("Not Found"), {
      isAxiosError: true,
      response: { status: 404 },
    });
    mockApiDelete.mockRejectedValueOnce(err);

    const { result } = renderHook(() => useFarcasterSync());
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });

    await act(async () => {
      await expect(result.current.revoke()).resolves.toBeUndefined();
    });

    expect(secureStore[__TEST_STORAGE_KEY__]).toBeUndefined();
    expect(result.current.enabled).toBe(false);
  });

  it("revoke still clears local storage when backend throws non-404", async () => {
    seedBearer();
    mockApiDelete.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useFarcasterSync());
    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });

    await act(async () => {
      await expect(result.current.revoke()).resolves.toBeUndefined();
    });

    expect(secureStore[__TEST_STORAGE_KEY__]).toBeUndefined();
    expect(result.current.enabled).toBe(false);
  });

  it("ensureBearer returns the cached bearer when valid", async () => {
    seedBearer();
    const { result } = renderHook(() => useFarcasterSync());

    await waitFor(() => {
      expect(result.current.enabled).toBe(true);
    });

    let returned: FarcasterBearer | null = null;
    await act(async () => {
      returned = await result.current.ensureBearer();
    });

    expect(returned).not.toBeNull();
    expect(returned!.fid).toBe(FID);
    expect(returned!.secret).toBe(SECRET);
  });

  it("ensureBearer returns null when no bearer is present", async () => {
    const { result } = renderHook(() => useFarcasterSync());

    let returned: FarcasterBearer | null = null;
    await act(async () => {
      returned = await result.current.ensureBearer();
    });

    expect(returned).toBeNull();
  });
});
