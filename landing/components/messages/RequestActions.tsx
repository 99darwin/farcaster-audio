"use client";

import { useState } from "react";
import { useMessageStore } from "@/lib/stores/messageStore";
import { cn } from "@/components/ui/cn";

type RequestDecision = "accept" | "decline";

export interface RequestActionsProps {
  conversationId: string;
  /** Shown in the accessible labels ("Accept request from Alice"). */
  title: string;
  /** Called after the store settles the decision (e.g. to navigate away). */
  onDecided?: (decision: RequestDecision) => void;
  onError: (message: string) => void;
  /** Roving tabindex when rendered inside a list row. */
  tabIndex?: 0 | -1;
  className?: string;
}

const ERROR_MESSAGES: Record<RequestDecision, string> = {
  accept: "Couldn't accept the request",
  decline: "Couldn't decline the request",
};

/**
 * Accept / Decline for a message request. The store moves the row
 * optimistically and reverts on failure; this only tracks the in-flight state.
 */
export function RequestActions({
  conversationId,
  title,
  onDecided,
  onError,
  tabIndex,
  className,
}: RequestActionsProps) {
  const [pending, setPending] = useState<RequestDecision | null>(null);

  const decide = async (decision: RequestDecision): Promise<void> => {
    if (pending) return;
    setPending(decision);
    const store = useMessageStore.getState();
    try {
      if (decision === "accept") await store.acceptRequest(conversationId);
      else await store.declineRequest(conversationId);
      onDecided?.(decision);
    } catch {
      onError(ERROR_MESSAGES[decision]);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className={cn("flex items-center gap-2", className)} role="group" aria-label={`Request from ${title}`}>
      <button
        type="button"
        disabled={pending !== null}
        tabIndex={tabIndex}
        onClick={() => void decide("accept")}
        aria-label={`Accept request from ${title}`}
        className="rounded-full bg-juke-orange px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-juke-orange-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange focus-visible:ring-offset-2 focus-visible:ring-offset-juke-navy disabled:opacity-60"
      >
        {pending === "accept" ? "Accepting…" : "Accept"}
      </button>
      <button
        type="button"
        disabled={pending !== null}
        tabIndex={tabIndex}
        onClick={() => void decide("decline")}
        aria-label={`Decline request from ${title}`}
        className="rounded-full border border-juke-border px-3 py-1 text-xs font-semibold text-juke-text-on-dark-secondary transition-colors hover:text-juke-text-on-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange disabled:opacity-60"
      >
        {pending === "decline" ? "Declining…" : "Decline"}
      </button>
    </div>
  );
}
