import { useState, useEffect, useCallback, useRef } from "react";
import { AppState, AppStateStatus } from "react-native";
import * as Updates from "expo-updates";
import * as Sentry from "@sentry/react-native";

export type OTAUpdateStatus =
  | "idle"
  | "checking"
  | "downloading"
  | "ready"
  | "restarting"
  | "error";

export type OTAUpdateErrorStage = "check" | "download" | "restart";

export interface OTAUpdateLogEntry {
  timestamp: number;
  level: string;
  code: string;
  message: string;
  updateId?: string;
  assetId?: string;
}

export interface OTAUpdateDiagnostics {
  channel: string | null;
  runtimeVersion: string | null;
  currentUpdateId: string | null;
  downloadedUpdateId: string | null;
  isEnabled: boolean;
  logs: OTAUpdateLogEntry[];
}

export interface OTAUpdateError {
  stage: OTAUpdateErrorStage;
  message: string;
}

interface OTAUpdateState {
  status: OTAUpdateStatus;
  isUpdateAvailable: boolean;
  error: OTAUpdateError | null;
  diagnostics: OTAUpdateDiagnostics;
}

const MAX_DIAGNOSTIC_LOGS = 20;
const MAX_LOG_MESSAGE_LENGTH = 500;
const DIAGNOSTIC_TIMEOUT_MS = 1500;

const ERROR_MESSAGES: Record<OTAUpdateErrorStage, string> = {
  check: "Couldn't check for updates.",
  download: "Couldn't download the update.",
  restart: "Couldn't restart to apply the update. Try again.",
};

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/gi, "$1[redacted]@")
    .replace(/(authorization\s*[:=]\s*)[^\r\n,}]+/gi, "$1[redacted]")
    .replace(/([?&][^=&#\s]+)=([^&#\s]+)/g, "$1=[redacted]")
    .replace(
      /(\b(?:access_token|api[_-]?key|password|secret|signature|token)\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|\S+)/gi,
      "$1[redacted]",
    )
    .replace(
      /(\"(?:access_token|api[_-]?key|authorization|password|secret|token)\"\s*:\s*\")[^\"]+/gi,
      "$1[redacted]",
    )
    .slice(0, MAX_LOG_MESSAGE_LENGTH);
}

function releaseDiagnostics(
  logs: OTAUpdateLogEntry[] = [],
  downloadedUpdateId: string | null = null,
): OTAUpdateDiagnostics {
  return {
    channel: Updates.channel ?? null,
    runtimeVersion: Updates.runtimeVersion ?? null,
    currentUpdateId: Updates.updateId ?? null,
    downloadedUpdateId,
    isEnabled: Updates.isEnabled,
    logs,
  };
}

async function collectDiagnostics(
  downloadedUpdateId: string | null,
): Promise<OTAUpdateDiagnostics> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const logs = await Promise.race([
      Updates.readLogEntriesAsync(),
      new Promise<Awaited<ReturnType<typeof Updates.readLogEntriesAsync>>>(
        (resolve) => {
          timeout = setTimeout(() => resolve([]), DIAGNOSTIC_TIMEOUT_MS);
        },
      ),
    ]);
    return releaseDiagnostics(
      logs.slice(-MAX_DIAGNOSTIC_LOGS).map((entry) => ({
        timestamp: entry.timestamp,
        level: entry.level,
        code: entry.code,
        message: redactDiagnosticText(entry.message),
        updateId: entry.updateId,
        assetId: entry.assetId,
      })),
      downloadedUpdateId,
    );
  } catch {
    return releaseDiagnostics([], downloadedUpdateId);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function errorSummary(error: unknown): string {
  return redactDiagnosticText(
    error instanceof Error ? error.message : String(error),
  );
}

export function useOTAUpdate() {
  const nativeUpdates = Updates.useUpdates();
  const nativeDownloadedUpdateId =
    nativeUpdates.downloadedUpdate?.updateId ?? null;
  const hasNativePendingUpdate =
    nativeUpdates.isUpdatePending || nativeUpdates.downloadedUpdate != null;
  const [state, setState] = useState<OTAUpdateState>({
    status: hasNativePendingUpdate ? "ready" : "idle",
    isUpdateAvailable: hasNativePendingUpdate,
    error: null,
    diagnostics: releaseDiagnostics([], nativeDownloadedUpdateId),
  });
  const hasCheckedRef = useRef(false);
  const pendingUpdateRef = useRef(hasNativePendingUpdate);
  const downloadedUpdateIdRef = useRef<string | null>(
    nativeDownloadedUpdateId,
  );
  const checkPromiseRef = useRef<Promise<void> | null>(null);

  const recordFailure = useCallback(
    (stage: OTAUpdateErrorStage, error: unknown) => {
      const failure: OTAUpdateError = {
        stage,
        message: ERROR_MESSAGES[stage],
      };
      const safeError = errorSummary(error);
      setState({
        status: "error",
        isUpdateAvailable: pendingUpdateRef.current,
        error: failure,
        diagnostics: releaseDiagnostics([], downloadedUpdateIdRef.current),
      });
      void collectDiagnostics(downloadedUpdateIdRef.current).then(
        (diagnostics) => {
          const report = {
            stage,
            error: safeError,
            diagnostics,
          };
          Sentry.captureException(new Error(ERROR_MESSAGES[stage]), {
            tags: {
              context: "ota_update",
              stage,
              channel: diagnostics.channel ?? "unknown",
              runtimeVersion: diagnostics.runtimeVersion ?? "unknown",
            },
            extra: report,
          });
          console.error("[OTA update] operation failed", {
            ...report,
          });
          setState((current) =>
            current.status === "error" && current.error?.stage === stage
              ? { ...current, diagnostics }
              : current,
          );
        },
      );
      return failure;
    },
    [],
  );

  const checkForUpdate = useCallback((): Promise<void> => {
    if (__DEV__ || !Updates.isEnabled || pendingUpdateRef.current) {
      return Promise.resolve();
    }
    if (checkPromiseRef.current) return checkPromiseRef.current;

    const checkPromise = (async () => {
      setState((current) => ({
        ...current,
        status: "checking",
        error: null,
      }));

      let result: Awaited<ReturnType<typeof Updates.checkForUpdateAsync>>;
      try {
        result = await Updates.checkForUpdateAsync();
      } catch (error) {
        recordFailure("check", error);
        return;
      }

      if (!result.isAvailable && !result.isRollBackToEmbedded) {
        setState((current) => ({
          ...current,
          status: "idle",
          isUpdateAvailable: false,
          error: null,
        }));
        return;
      }

      setState((current) => ({
        ...current,
        status: "downloading",
      }));
      try {
        const download = await Updates.fetchUpdateAsync();
        if (download.isNew || download.isRollBackToEmbedded) {
          pendingUpdateRef.current = true;
          setState((current) => ({
            ...current,
            status: "ready",
            isUpdateAvailable: true,
            error: null,
            diagnostics: releaseDiagnostics(
              [],
              downloadedUpdateIdRef.current,
            ),
          }));
        } else {
          setState((current) => ({
            ...current,
            status: "idle",
            isUpdateAvailable: false,
            error: null,
          }));
        }
      } catch (error) {
        recordFailure("download", error);
      }
    })();

    checkPromiseRef.current = checkPromise;
    void checkPromise.finally(() => {
      if (checkPromiseRef.current === checkPromise) {
        checkPromiseRef.current = null;
      }
    });
    return checkPromise;
  }, [recordFailure]);

  const applyUpdate = useCallback(async () => {
    if (!pendingUpdateRef.current) return;
    setState((current) => ({
      ...current,
      status: "restarting",
      isUpdateAvailable: true,
      error: null,
    }));
    try {
      await Updates.reloadAsync();
    } catch (error) {
      const failure = recordFailure("restart", error);
      throw new Error(failure.message);
    }
  }, [recordFailure]);

  const dismiss = useCallback(() => {
    setState((current) => ({
      ...current,
      isUpdateAvailable: false,
    }));
  }, []);

  useEffect(() => {
    if (!hasNativePendingUpdate) return;
    pendingUpdateRef.current = true;
    downloadedUpdateIdRef.current = nativeDownloadedUpdateId;
    setState((current) =>
      current.status === "restarting"
        ? current
        : {
            ...current,
            status: "ready",
            isUpdateAvailable: true,
            error: null,
            diagnostics: releaseDiagnostics([], nativeDownloadedUpdateId),
          },
    );
  }, [hasNativePendingUpdate, nativeDownloadedUpdateId]);

  useEffect(() => {
    if (!hasCheckedRef.current) {
      hasCheckedRef.current = true;
      void checkForUpdate();
    }
  }, [checkForUpdate]);

  useEffect(() => {
    const handleAppState = (next: AppStateStatus) => {
      if (next === "active") void checkForUpdate();
    };
    const subscription = AppState.addEventListener("change", handleAppState);
    return () => subscription.remove();
  }, [checkForUpdate]);

  return {
    ...state,
    isDownloading: state.status === "downloading",
    isRestarting: state.status === "restarting",
    checkForUpdate,
    applyUpdate,
    dismiss,
  };
}
