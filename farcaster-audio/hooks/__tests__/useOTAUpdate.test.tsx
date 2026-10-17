import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { AppState, type AppStateStatus } from "react-native";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as Updates from "expo-updates";
import * as Sentry from "@sentry/react-native";
import { useOTAUpdate } from "../useOTAUpdate";

const mockCheckForUpdateAsync = jest.mocked(Updates.checkForUpdateAsync);
const mockFetchUpdateAsync = jest.mocked(Updates.fetchUpdateAsync);
const mockReloadAsync = jest.mocked(Updates.reloadAsync);
const mockReadLogEntriesAsync = jest.mocked(Updates.readLogEntriesAsync);
const mockCaptureException = jest.mocked(Sentry.captureException);

let appStateListener: ((state: AppStateStatus) => void) | null = null;
let originalDev: boolean;
let mockUpdatesState: {
  isUpdatePending: boolean;
  downloadedUpdate?: { updateId: string };
};

jest.mock("expo-updates", () => ({
  isEnabled: true,
  channel: "production",
  runtimeVersion: "0.1.0",
  updateId: "current-update-id",
  checkForUpdateAsync: jest.fn(),
  fetchUpdateAsync: jest.fn(),
  reloadAsync: jest.fn(),
  readLogEntriesAsync: jest.fn(),
  useUpdates: () => mockUpdatesState,
}));

jest.mock("@sentry/react-native", () => ({
  captureException: jest.fn(),
}));

const updateAvailable = { isAvailable: true } as Awaited<
  ReturnType<typeof Updates.checkForUpdateAsync>
>;
const noUpdate = { isAvailable: false } as Awaited<
  ReturnType<typeof Updates.checkForUpdateAsync>
>;
const rollbackAvailable = {
  isAvailable: false,
  isRollBackToEmbedded: true,
  manifest: undefined,
  reason: undefined,
} as Awaited<ReturnType<typeof Updates.checkForUpdateAsync>>;
const downloadedUpdate = {
  isNew: true,
  isRollBackToEmbedded: false,
  manifest: {},
} as Awaited<ReturnType<typeof Updates.fetchUpdateAsync>>;
const downloadedRollback = {
  isNew: false,
  isRollBackToEmbedded: true,
  manifest: undefined,
} as Awaited<ReturnType<typeof Updates.fetchUpdateAsync>>;

describe("useOTAUpdate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    appStateListener = null;
    mockUpdatesState = { isUpdatePending: false };
    originalDev = __DEV__;
    Object.defineProperty(global, "__DEV__", {
      configurable: true,
      value: false,
    });
    jest
      .spyOn(AppState, "addEventListener")
      .mockImplementation((_event, listener) => {
        appStateListener = listener;
        return { remove: jest.fn() };
      });
    mockCheckForUpdateAsync.mockResolvedValue(noUpdate);
    mockFetchUpdateAsync.mockResolvedValue(downloadedUpdate);
    mockReloadAsync.mockResolvedValue(undefined);
    mockReadLogEntriesAsync.mockResolvedValue([]);
    jest.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    Object.defineProperty(global, "__DEV__", {
      configurable: true,
      value: originalDev,
    });
    jest.restoreAllMocks();
  });

  it("checks, downloads, and exposes a ready update", async () => {
    mockCheckForUpdateAsync.mockResolvedValue(updateAvailable);
    mockFetchUpdateAsync.mockResolvedValue(downloadedUpdate);

    const { result } = renderHook(() => useOTAUpdate());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mockCheckForUpdateAsync).toHaveBeenCalledTimes(1);
    expect(mockFetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(result.current.isUpdateAvailable).toBe(true);
    expect(result.current.isDownloading).toBe(false);
    expect(result.current.diagnostics).toMatchObject({
      channel: "production",
      runtimeVersion: "0.1.0",
      currentUpdateId: "current-update-id",
      isEnabled: true,
    });
  });

  it("returns to idle when no update is available", async () => {
    const { result } = renderHook(() => useOTAUpdate());

    await waitFor(() => expect(mockCheckForUpdateAsync).toHaveBeenCalled());
    await waitFor(() => expect(result.current.status).toBe("idle"));
    expect(mockFetchUpdateAsync).not.toHaveBeenCalled();
    expect(result.current.isUpdateAvailable).toBe(false);
  });

  it("fetches and readies a rollback-to-embedded directive", async () => {
    mockCheckForUpdateAsync.mockResolvedValue(rollbackAvailable);
    mockFetchUpdateAsync.mockResolvedValue(downloadedRollback);

    const { result } = renderHook(() => useOTAUpdate());

    await waitFor(() => expect(result.current.status).toBe("ready"));
    expect(mockFetchUpdateAsync).toHaveBeenCalledTimes(1);
    expect(result.current.isUpdateAvailable).toBe(true);

    await act(async () => result.current.applyUpdate());
    expect(mockReloadAsync).toHaveBeenCalledTimes(1);
  });

  it("surfaces an update downloaded by the native startup state machine", async () => {
    mockUpdatesState = {
      isUpdatePending: true,
      downloadedUpdate: { updateId: "native-downloaded-id" },
    };

    const { result } = renderHook(() => useOTAUpdate());

    expect(result.current.status).toBe("ready");
    expect(result.current.isUpdateAvailable).toBe(true);
    expect(result.current.diagnostics.downloadedUpdateId).toBe(
      "native-downloaded-id",
    );
    expect(mockCheckForUpdateAsync).not.toHaveBeenCalled();
  });

  it("records check failures with sanitized diagnostics", async () => {
    mockCheckForUpdateAsync.mockRejectedValue(
      new Error(
        "request failed Bearer super-secret Authorization: Basic another-secret",
      ),
    );
    mockReadLogEntriesAsync.mockResolvedValue([
      {
        timestamp: 123,
        level: "error",
        code: "UpdateServerUnreachable",
        message: "failed https://u.expo.dev/path?token=also-secret",
      },
    ] as Awaited<ReturnType<typeof Updates.readLogEntriesAsync>>);

    const { result } = renderHook(() => useOTAUpdate());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toEqual({
      stage: "check",
      message: "Couldn't check for updates.",
    });
    await waitFor(() =>
      expect(result.current.diagnostics.logs[0]?.message).toContain(
        "token=[redacted]",
      ),
    );
    expect(JSON.stringify(result.current.diagnostics)).not.toContain(
      "also-secret",
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(
      "super-secret",
    );
    expect(JSON.stringify((console.error as jest.Mock).mock.calls)).not.toContain(
      "another-secret",
    );
    await waitFor(() => expect(mockCaptureException).toHaveBeenCalledTimes(1));
    const sentryPayload = JSON.stringify(mockCaptureException.mock.calls);
    expect(sentryPayload).toContain("ota_update");
    expect(sentryPayload).toContain("UpdateServerUnreachable");
    expect(sentryPayload).not.toContain("super-secret");
    expect(sentryPayload).not.toContain("another-secret");
    expect(sentryPayload).not.toContain("also-secret");
  });

  it("records download failures without showing an unavailable update", async () => {
    mockCheckForUpdateAsync.mockResolvedValue(updateAvailable);
    mockFetchUpdateAsync.mockRejectedValue(new Error("asset timeout"));

    const { result } = renderHook(() => useOTAUpdate());

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error?.stage).toBe("download");
    expect(result.current.isUpdateAvailable).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      "[OTA update] operation failed",
      expect.objectContaining({ stage: "download" }),
    );
  });

  it("coalesces concurrent mount and foreground checks", async () => {
    let resolveCheck: ((value: typeof noUpdate) => void) | undefined;
    mockCheckForUpdateAsync.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
    );
    const { result } = renderHook(() => useOTAUpdate());
    await waitFor(() => expect(result.current.status).toBe("checking"));

    act(() => {
      appStateListener?.("active");
      appStateListener?.("active");
      void result.current.checkForUpdate();
    });

    expect(mockCheckForUpdateAsync).toHaveBeenCalledTimes(1);
    await act(async () => resolveCheck?.(noUpdate));
    await waitFor(() => expect(result.current.status).toBe("idle"));
  });

  it("keeps the restarting state after reload succeeds", async () => {
    mockCheckForUpdateAsync.mockResolvedValue(updateAvailable);
    const { result } = renderHook(() => useOTAUpdate());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => result.current.applyUpdate());

    expect(mockReloadAsync).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("restarting");
    expect(result.current.isRestarting).toBe(true);
  });

  it("restores a retryable update after reload fails", async () => {
    mockCheckForUpdateAsync.mockResolvedValue(updateAvailable);
    mockReloadAsync.mockRejectedValue(new Error("native reload unavailable"));
    const { result } = renderHook(() => useOTAUpdate());
    await waitFor(() => expect(result.current.status).toBe("ready"));

    await act(async () => {
      await expect(result.current.applyUpdate()).rejects.toThrow(
        "Couldn't restart to apply the update. Try again.",
      );
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.stage).toBe("restart");
    expect(result.current.isUpdateAvailable).toBe(true);
    expect(result.current.isRestarting).toBe(false);

    mockReloadAsync.mockResolvedValue(undefined);
    await act(async () => result.current.applyUpdate());
    expect(mockReloadAsync).toHaveBeenCalledTimes(2);
  });
});
