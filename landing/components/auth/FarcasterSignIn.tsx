"use client";

/**
 * Sign in with Farcaster on the Hypersnap protocol — no hosted signer, no Farcaster
 * client, no auth server.
 *
 *   1. The user names their account (FID or username).
 *   2. If this browser already holds a linked auth address, it signs an `hqa1`
 *      token and we're done.
 *   3. Otherwise the user enters their Farcaster recovery phrase once. It's
 *      used in this tab to approve this browser's auth address and Juke's
 *      posting key on-chain, then forgotten.
 *
 * Callers decide what a session means (the `/app` auth store, the developer
 * dashboard client) via `onLogin`.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { LoginResponse } from "@/lib/api/types";
import {
  AuthAddressStorageError,
  getBrowserAuthAddressStore,
} from "@/lib/auth/authAddressStore";
import {
  AuthRequestError,
  CustodyMismatchError,
  FarcasterUserNotFoundError,
  InvalidRecoveryPhraseError,
  LinkRequiredError,
  SignerLinkFailedError,
  UnexpectedSigningRequestError,
  resolveFid,
  type AuthApiOptions,
} from "@/lib/auth/protocolLogin";
import { InvalidMessagingTokenRequestError } from "@/lib/auth/messagingToken";
import {
  linkBrowserWithRecoveryPhrase,
  readLastFid,
  signInReturningBrowser,
  writeLastFid,
  type LinkProgress,
} from "@/lib/auth/webSignIn";
import {
  INPUT,
  PRIMARY_BUTTON,
  RecoveryPhraseEntry,
  SECONDARY_BUTTON,
} from "./RecoveryPhraseEntry";

const LINK_PROGRESS_LABEL: Record<LinkProgress, string> = {
  preparing: "Preparing…",
  signing: "Signing in this tab…",
  submitting: "Submitting to Optimism…",
  pending: "Waiting for the transaction…",
  submitted: "Confirming on-chain…",
  approved: "Approved — signing you in…",
};

type Step =
  | { kind: "identify" }
  | { kind: "signing-in"; fid: number }
  | { kind: "link"; fid: number }
  | { kind: "linking"; fid: number; progress: LinkProgress };

export interface FarcasterSignInProps {
  /** Receives the minted session. May be async; errors surface inline. */
  onLogin: (response: LoginResponse) => void | Promise<void>;
  /** Primary button label on the identify step. */
  label?: string;
  /**
   * Open straight on the recovery-phrase link step for this FID — used when a
   * signed-in user's `signer_status` isn't `approved` (contract section 3).
   * Read on mount only; remount (via `key`) to change it.
   */
  relinkFid?: number;
  /**
   * Transport options for the auth calls. The embed passes
   * `{ useCookie: false }` so the refresh token comes back in the body.
   * Read on mount only, like `relinkFid`.
   */
  authOptions?: AuthApiOptions;
}

export function FarcasterSignIn({
  onLogin,
  label = "Sign in with Farcaster",
  relinkFid,
  authOptions,
}: FarcasterSignInProps) {
  const authOptionsRef = useRef(authOptions);
  const [step, setStep] = useState<Step>(() =>
    relinkFid === undefined ? { kind: "identify" } : { kind: "link", fid: relinkFid },
  );
  const [error, setError] = useState<string | null>(null);
  const [lastFid, setLastFid] = useState<number | null>(null);
  const [accountQuery, setAccountQuery] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setLastFid(readLastFid());
    return () => abortRef.current?.abort();
  }, []);

  const finish = useCallback(
    async (fid: number, response: LoginResponse) => {
      writeLastFid(fid);
      setLastFid(fid);
      await onLogin(response);
      setStep({ kind: "identify" });
    },
    [onLogin],
  );

  const signInAs = useCallback(
    async (fid: number) => {
      setError(null);
      setStep({ kind: "signing-in", fid });
      try {
        const response = await signInReturningBrowser(
          { fid, store: getBrowserAuthAddressStore() },
          authOptionsRef.current,
        );
        await finish(fid, response);
      } catch (err) {
        if (err instanceof LinkRequiredError) {
          setStep({ kind: "link", fid });
          return;
        }
        setError(describeError(err));
        setStep({ kind: "identify" });
      }
    },
    [finish],
  );

  async function handleIdentify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const fid = await resolveFid(accountQuery);
      await signInAs(fid);
    } catch (err) {
      setError(describeError(err));
    }
  }

  const handleLink = useCallback(
    async (fid: number, takeRecoveryPhrase: () => string) => {
      setError(null);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setStep({ kind: "linking", fid, progress: "preparing" });
      try {
        const response = await linkBrowserWithRecoveryPhrase(
          {
            fid,
            store: getBrowserAuthAddressStore(),
            takeRecoveryPhrase,
            signal: controller.signal,
            onProgress: (progress) => setStep({ kind: "linking", fid, progress }),
          },
          authOptionsRef.current,
        );
        await finish(fid, response);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(describeError(err));
        setStep({ kind: "link", fid });
      }
    },
    [finish],
  );

  function handleSwitchAccount() {
    abortRef.current?.abort();
    setError(null);
    setLastFid(null);
    writeLastFid(null);
    setStep({ kind: "identify" });
  }

  return (
    <div className="flex w-full flex-col gap-4">
      {step.kind === "identify" && lastFid !== null && (
        <div className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => void signInAs(lastFid)}
            className={PRIMARY_BUTTON}
          >
            Continue as FID {lastFid}
          </button>
          <button
            type="button"
            onClick={handleSwitchAccount}
            className={SECONDARY_BUTTON}
          >
            Use a different account
          </button>
        </div>
      )}

      {step.kind === "identify" && lastFid === null && (
        <form onSubmit={handleIdentify} className="flex flex-col gap-3">
          <label className="block">
            <span className="text-xs font-medium text-juke-text-on-dark-secondary">
              Farcaster username or FID
            </span>
            <input
              value={accountQuery}
              onChange={(e) => setAccountQuery(e.target.value)}
              placeholder="@username or 12345"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              className={INPUT}
            />
          </label>
          <button
            type="submit"
            disabled={!accountQuery.trim()}
            className={PRIMARY_BUTTON}
          >
            {label}
          </button>
        </form>
      )}

      {step.kind === "signing-in" && (
        <p className="text-center text-sm text-juke-text-on-dark-secondary" role="status">
          Signing in as FID {step.fid}…
        </p>
      )}

      {(step.kind === "link" || step.kind === "linking") && (
        <RecoveryPhraseEntry
          title={`Link this browser to FID ${step.fid}`}
          description={
            <>
              Enter the recovery phrase for your Farcaster account (its custody
              address — not a wallet app&apos;s phrase). It&apos;s used once, in
              this tab, to approve this browser and Juke&apos;s posting key
              on-chain. It is never sent to Juke or stored.
            </>
          }
          submitLabel="Approve this browser"
          busyLabel={step.kind === "linking" ? LINK_PROGRESS_LABEL[step.progress] : null}
          footer="Juke pays the gas. You can revoke this browser any time from your Farcaster key settings."
          onSubmit={(take) => void handleLink(step.fid, take)}
          onCancel={handleSwitchAccount}
        />
      )}

      {error && (
        <p className="text-center text-sm text-red-300" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function describeError(err: unknown): string {
  if (
    err instanceof CustodyMismatchError ||
    err instanceof InvalidRecoveryPhraseError ||
    err instanceof SignerLinkFailedError ||
    err instanceof UnexpectedSigningRequestError ||
    err instanceof InvalidMessagingTokenRequestError ||
    err instanceof FarcasterUserNotFoundError ||
    err instanceof AuthAddressStorageError
  ) {
    return err.message;
  }
  if (err instanceof AuthRequestError) {
    switch (err.code) {
      case "fid_not_found":
        return "That FID isn't registered.";
      case "prepare_expired":
        return "That took too long. Enter your phrase again.";
      case "invalid_signature":
      case "invalid_token":
        return "The signature didn't verify. Check the phrase and try again.";
      default:
        if (err.status === 429) return "Too many attempts. Wait a minute and try again.";
        return "Sign in failed. Try again.";
    }
  }
  return "Sign in failed. Try again.";
}
