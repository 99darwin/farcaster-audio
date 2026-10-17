"use client";

import { useState } from "react";
import { ApiFetchError } from "@/lib/api/client";
import { enableMessaging } from "@/lib/api/messages";
import type { MessagingTokenStatus } from "@/lib/api/messages.types";
import {
  AuthRequestError,
  CustodyMismatchError,
  FarcasterUserNotFoundError,
  InvalidRecoveryPhraseError,
  fetchCustodyAddress,
  signMessagingToken,
} from "@/lib/auth/protocolLogin";
import { InvalidMessagingTokenRequestError } from "@/lib/auth/messagingToken";
import { RecoveryPhraseEntry } from "@/components/auth/RecoveryPhraseEntry";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { ChatBubbleIcon } from "./icons";

const EXPIRED_DESCRIPTION =
  "Your messaging access expired. Re-enter your recovery phrase to turn messages back on.";
const MISSING_DESCRIPTION =
  "Direct Casts need a one-time approval from your Farcaster account. Enter your recovery phrase to turn messages on.";

type Step = "cta" | "entry" | "enabling";

/**
 * Shown when the Direct Cast token isn't active. Custody signs only the
 * `generateToken` request in this tab; the phrase is read once from the
 * uncontrolled field and never leaves {@link signMessagingToken}.
 */
export function EnableMessagesGate({
  fid,
  custodyAddress,
  tokenStatus,
  onEnabled,
}: {
  fid: number;
  /** From the session; looked up on Hypersnap when absent. */
  custodyAddress: string | null;
  tokenStatus: MessagingTokenStatus | null;
  onEnabled: () => Promise<void>;
}) {
  const [step, setStep] = useState<Step>("cta");
  const [error, setError] = useState<string | null>(null);
  const isExpired = tokenStatus === "expired";

  async function handleSubmit(takeRecoveryPhrase: () => string) {
    setError(null);
    setStep("enabling");
    try {
      const custody = custodyAddress ?? (await fetchCustodyAddress(fid));
      const signed = await signMessagingToken({
        phrase: takeRecoveryPhrase(),
        fid,
        custodyAddress: custody,
      });
      await enableMessaging(signed);
      await onEnabled();
    } catch (err) {
      setError(describeEnableError(err));
      setStep("entry");
    }
  }

  if (step === "cta") {
    return (
      <EmptyState
        icon={<ChatBubbleIcon className="h-8 w-8" />}
        title={isExpired ? "Turn messages back on" : "Enable messages"}
        description={isExpired ? EXPIRED_DESCRIPTION : MISSING_DESCRIPTION}
        action={<Button onClick={() => setStep("entry")}>Enable messages</Button>}
      />
    );
  }

  return (
    <div className="flex w-full max-w-sm flex-col gap-4">
      <RecoveryPhraseEntry
        title="Enable messages"
        description={
          <>
            {isExpired ? EXPIRED_DESCRIPTION : MISSING_DESCRIPTION} It&apos;s used
            once, in this tab, to sign a 90-day messaging approval. It is never
            sent to Juke or stored.
          </>
        }
        submitLabel="Enable messages"
        busyLabel={step === "enabling" ? "Enabling messages…" : null}
        onSubmit={(take) => void handleSubmit(take)}
        onCancel={() => {
          setError(null);
          setStep("cta");
        }}
      />
      {error && (
        <p className="text-center text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function describeEnableError(err: unknown): string {
  if (
    err instanceof CustodyMismatchError ||
    err instanceof InvalidRecoveryPhraseError ||
    err instanceof InvalidMessagingTokenRequestError ||
    err instanceof FarcasterUserNotFoundError
  ) {
    return err.message;
  }
  if (err instanceof AuthRequestError) {
    return "Couldn't look up your account's custody address. Try again.";
  }
  if (err instanceof ApiFetchError) {
    if (err.detail === "invalid_signature" || err.detail === "invalid_auth_request") {
      return "The signature didn't verify. Check the phrase and try again.";
    }
    if (err.status === 429) return "Too many attempts. Wait a minute and try again.";
    if (err.status === 502 || err.status === 503) {
      return "Farcaster messaging is unavailable right now. Try again in a few minutes.";
    }
  }
  return "Couldn't enable messages. Try again.";
}
