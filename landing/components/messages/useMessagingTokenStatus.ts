"use client";

import { useCallback, useEffect, useState } from "react";
import { getMessagingStatus, isMessagingDisabledError } from "@/lib/api/messages";
import type { MessagingStatus } from "@/lib/api/messages.types";

export type MessagingTokenGate =
  | { kind: "loading" }
  | { kind: "disabled" }
  /** Status unreadable; the surface loads and the API gates each call. */
  | { kind: "unknown" }
  | { kind: "ready"; status: MessagingStatus };

/**
 * Read `GET /v1/messages/status` once `isActive`, so the shell can gate on the
 * custody-signed Direct Cast token. `refresh` re-reads it after enabling.
 */
export function useMessagingTokenStatus(isActive: boolean): {
  gate: MessagingTokenGate;
  refresh: () => Promise<void>;
} {
  const [gate, setGate] = useState<MessagingTokenGate>({ kind: "loading" });

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const status = await getMessagingStatus(signal);
      if (signal?.aborted) return;
      setGate(status.enabled ? { kind: "ready", status } : { kind: "disabled" });
    } catch (error) {
      if (signal?.aborted) return;
      setGate(isMessagingDisabledError(error) ? { kind: "disabled" } : { kind: "unknown" });
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [isActive, refresh]);

  return { gate, refresh: useCallback(() => refresh(), [refresh]) };
}
