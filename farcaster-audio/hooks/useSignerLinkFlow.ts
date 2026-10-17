/**
 * Sign-in / re-link state machine for Hypersnap auth (frozen auth contract).
 *
 *   lookup ─► looking_up ─► confirm ─► signing_in ──────────────► done
 *                              │            │ (no key / 403 signer_not_linked)
 *                              │            ▼
 *                              └──────► preparing ─► phrase ─► registering
 *                                                      ▲            │
 *                                    phrase rejected ──┘            ▼
 *                                                          waiting (poll) ─► done
 *
 * The recovery phrase is never part of this state. `submitPhrase` receives
 * it as an argument and passes it to `signWithPhrase`, the only frame that
 * holds it; register + poll then run with the signed request alone.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import * as api from "@/services/api";
import {
  getOrCreateAuthAddress,
  markAuthAddressApproved,
} from "@/services/authAddress";
import {
  DeviceLoginError,
  loginWithAuthAddress,
  loginWithAuthAddressAfterLink,
} from "@/services/deviceLogin";
import {
  FarcasterLookupError,
  lookupFarcasterUser,
  type FarcasterUserSummary,
} from "@/services/farcasterLookup";
import {
  isPrepareExpiring,
  pollSignerStatus,
  signSignerLink,
  SignerLinkError,
} from "@/services/signerLink";
import { saveLastLinkedFid } from "@/services/storage";
import { useAuthStore } from "@/stores/authStore";
import type {
  LoginResponse,
  SignerLinkStatus,
  SignerPrepareResponse,
  SignerRegisterRequest,
} from "@/types/api";

export type SignerLinkMode = "login" | "relink";

export type SignerLinkState =
  | { step: "lookup"; error: string | null }
  | { step: "looking_up" }
  | { step: "confirm"; user: FarcasterUserSummary; error: string | null }
  | { step: "signing_in"; user: FarcasterUserSummary }
  | { step: "preparing"; user: FarcasterUserSummary }
  | {
      step: "phrase";
      user: FarcasterUserSummary;
      prepare: SignerPrepareResponse;
      error: string | null;
    }
  | {
      step: "registering";
      user: FarcasterUserSummary;
      prepare: SignerPrepareResponse;
    }
  | {
      step: "waiting";
      user: FarcasterUserSummary;
      prepareId: string;
      linkStatus: SignerLinkStatus;
    }
  | { step: "done"; user: FarcasterUserSummary };

export type SignerLinkEvent =
  | { type: "LOOKUP_STARTED" }
  | { type: "LOOKUP_FAILED"; error: string }
  | { type: "USER_FOUND"; user: FarcasterUserSummary }
  | { type: "RESET" }
  | { type: "SIGN_IN_STARTED" }
  | { type: "PREPARE_STARTED" }
  | { type: "PREPARED"; prepare: SignerPrepareResponse }
  | { type: "PHRASE_REJECTED"; error: string }
  | { type: "REGISTER_STARTED"; prepare: SignerPrepareResponse }
  | { type: "LINK_STATUS"; prepareId: string; linkStatus: SignerLinkStatus }
  | { type: "COMPLETED" }
  | { type: "FAILED"; error: string };

export const INITIAL_SIGNER_LINK_STATE: SignerLinkState = {
  step: "lookup",
  error: null,
};

function userOf(state: SignerLinkState): FarcasterUserSummary | null {
  return "user" in state ? state.user : null;
}

/**
 * Pure transition function. Events that don't apply to the current step are
 * ignored, so a late async result can't drag the flow backwards.
 */
export function signerLinkReducer(
  state: SignerLinkState,
  event: SignerLinkEvent,
): SignerLinkState {
  const user = userOf(state);
  switch (event.type) {
    case "RESET":
      return INITIAL_SIGNER_LINK_STATE;
    case "LOOKUP_STARTED":
      return state.step === "lookup" ? { step: "looking_up" } : state;
    case "LOOKUP_FAILED":
      return state.step === "looking_up"
        ? { step: "lookup", error: event.error }
        : state;
    case "USER_FOUND":
      return state.step === "looking_up" || state.step === "lookup"
        ? { step: "confirm", user: event.user, error: null }
        : state;
    case "SIGN_IN_STARTED":
      return state.step === "confirm" && user
        ? { step: "signing_in", user }
        : state;
    case "PREPARE_STARTED":
      return (state.step === "confirm" || state.step === "signing_in") && user
        ? { step: "preparing", user }
        : state;
    case "PREPARED":
      return state.step === "preparing" && user
        ? { step: "phrase", user, prepare: event.prepare, error: null }
        : state;
    case "PHRASE_REJECTED":
      return state.step === "registering" && user
        ? { step: "phrase", user, prepare: state.prepare, error: event.error }
        : state;
    case "REGISTER_STARTED":
      return state.step === "phrase" && user
        ? { step: "registering", user, prepare: event.prepare }
        : state;
    case "LINK_STATUS":
      return (state.step === "registering" || state.step === "waiting") && user
        ? {
            step: "waiting",
            user,
            prepareId: event.prepareId,
            linkStatus: event.linkStatus,
          }
        : state;
    case "COMPLETED":
      return user ? { step: "done", user } : state;
    case "FAILED":
      if (!user) return { step: "lookup", error: event.error };
      return state.step === "done"
        ? state
        : { step: "confirm", user, error: event.error };
  }
}

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_TOO_MANY_REQUESTS = 429;

/** User-facing copy for a backend failure. Never includes request bodies. */
export function describeLinkError(error: unknown): string {
  if (error instanceof SignerLinkError) return error.message;
  if (error instanceof FarcasterLookupError) return error.message;
  if (error instanceof DeviceLoginError) return error.message;
  const status = api.getApiErrorStatus(error);
  const code = api.getApiErrorCode(error);
  if (status === HTTP_TOO_MANY_REQUESTS) {
    return "Too many attempts. Wait a minute and try again.";
  }
  if (status === HTTP_NOT_FOUND || code === "fid_not_found") {
    return "No Farcaster account found for that FID.";
  }
  if (status === HTTP_GONE || code === "prepare_expired") {
    return "That took too long and the request expired. Start again.";
  }
  if (code === "invalid_signature" || code === "invalid_token") {
    return "The signatures were rejected. Start again.";
  }
  if (status === null) {
    return "Couldn't reach Juke. Check your connection and try again.";
  }
  return "Something went wrong signing in. Try again.";
}

export interface UseSignerLinkFlowOptions {
  mode: SignerLinkMode;
  /** Skip lookup and start at the confirm step for this account. */
  initialUser?: FarcasterUserSummary;
}

export function useSignerLinkFlow({
  mode,
  initialUser,
}: UseSignerLinkFlowOptions) {
  const [state, dispatch] = useReducer(
    signerLinkReducer,
    initialUser
      ? { step: "confirm", user: initialUser, error: null }
      : INITIAL_SIGNER_LINK_STATE,
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const send = useCallback((event: SignerLinkEvent) => {
    if (isMountedRef.current) dispatch(event);
  }, []);

  const complete = useCallback(
    async (login: LoginResponse, fid: number) => {
      await useAuthStore.getState().setAuth(login);
      // A protocol login succeeding proves the auth address is in KeyRegistry.
      await markAuthAddressApproved(fid);
      await saveLastLinkedFid(fid);
      send({ type: "COMPLETED" });
    },
    [send],
  );

  const fetchPrepare = useCallback(async (fid: number) => {
    const { address } = await getOrCreateAuthAddress(fid);
    return api.prepareSigner({
      fid,
      auth_address: address.toLowerCase() as `0x${string}`,
    });
  }, []);

  const lookup = useCallback(
    async (query: string) => {
      send({ type: "LOOKUP_STARTED" });
      try {
        send({ type: "USER_FOUND", user: await lookupFarcasterUser(query) });
      } catch (error) {
        send({ type: "LOOKUP_FAILED", error: describeLinkError(error) });
      }
    },
    [send],
  );

  const prepare = useCallback(
    async (user: FarcasterUserSummary) => {
      send({ type: "PREPARE_STARTED" });
      try {
        send({ type: "PREPARED", prepare: await fetchPrepare(user.fid) });
      } catch (error) {
        if (
          api.getApiErrorStatus(error) === HTTP_CONFLICT &&
          api.getApiErrorCode(error) === "already_linked"
        ) {
          // Signer and this device's auth address are both on-chain already.
          await complete(await loginWithAuthAddress(user.fid), user.fid);
          return;
        }
        throw error;
      }
    },
    [complete, fetchPrepare, send],
  );

  const start = useCallback(async () => {
    const current = stateRef.current;
    if (current.step !== "confirm") return;
    const { user } = current;
    try {
      if (mode === "relink") {
        await prepare(user);
        return;
      }
      send({ type: "SIGN_IN_STARTED" });
      try {
        await complete(await loginWithAuthAddress(user.fid), user.fid);
      } catch (error) {
        if (!(error instanceof DeviceLoginError)) throw error;
        await prepare(user);
      }
    } catch (error) {
      send({ type: "FAILED", error: describeLinkError(error) });
    }
  }, [complete, mode, prepare, send]);

  /**
   * Phase 1: the only frame that ever holds the phrase. Returns the signed
   * register request (public keys + signatures only), or null after moving
   * the flow to the phrase-rejected / failed step.
   */
  const signWithPhrase = useCallback(
    async (
      phrase: string,
      user: FarcasterUserSummary,
      currentPrepare: SignerPrepareResponse,
    ): Promise<SignerRegisterRequest | null> => {
      try {
        const { address } = await getOrCreateAuthAddress(user.fid);
        const prepareResponse = isPrepareExpiring(currentPrepare)
          ? await fetchPrepare(user.fid)
          : currentPrepare;
        return await signSignerLink({
          phrase,
          fid: user.fid,
          authAddress: address,
          prepare: prepareResponse,
        });
      } catch (error) {
        if (
          error instanceof SignerLinkError &&
          (error.code === "phrase_invalid" || error.code === "phrase_mismatch")
        ) {
          send({ type: "PHRASE_REJECTED", error: error.message });
        } else {
          send({ type: "FAILED", error: describeLinkError(error) });
        }
        return null;
      }
    },
    [fetchPrepare, send],
  );

  /** Phase 2: relay + poll with the signed request; never sees the phrase. */
  const registerAndAwaitLink = useCallback(
    async (
      user: FarcasterUserSummary,
      registerRequest: SignerRegisterRequest,
    ): Promise<void> => {
      try {
        const registered = await api.registerSigner(registerRequest);
        send({
          type: "LINK_STATUS",
          prepareId: registered.prepare_id,
          linkStatus: registered.status,
        });
        await pollSignerStatus({
          prepareId: registered.prepare_id,
          getStatus: api.getSignerStatus,
          isCancelled: () => !isMountedRef.current,
          onStatus: (s) =>
            send({
              type: "LINK_STATUS",
              prepareId: s.prepare_id,
              linkStatus: s.status,
            }),
        });
        // The status poll only reports progress and never hands out a
        // session: the now-linked auth address signs in like any other day.
        const login = await loginWithAuthAddressAfterLink(user.fid);
        await complete(login, user.fid);
      } catch (error) {
        if (error instanceof SignerLinkError && error.code === "cancelled") {
          return;
        }
        send({ type: "FAILED", error: describeLinkError(error) });
      }
    },
    [complete, send],
  );

  /**
   * Sign with the phrase and register. Resolves once the flow has moved on;
   * the caller must already have cleared its own copy of the phrase.
   *
   * Deliberately not `async`: this frame returns synchronously, so the phrase
   * is reachable only from `signWithPhrase` and is dropped as soon as signing
   * settles, rather than staying alive through the minutes-long register +
   * poll that follows (auth contract §5).
   */
  const submitPhrase = useCallback(
    (phrase: string): Promise<void> => {
      const current = stateRef.current;
      if (current.step !== "phrase") return Promise.resolve();
      const { user, prepare: currentPrepare } = current;
      send({ type: "REGISTER_STARTED", prepare: currentPrepare });
      return signWithPhrase(phrase, user, currentPrepare).then(
        (registerRequest) =>
          registerRequest
            ? registerAndAwaitLink(user, registerRequest)
            : undefined,
      );
    },
    [registerAndAwaitLink, send, signWithPhrase],
  );

  const reset = useCallback(() => send({ type: "RESET" }), [send]);

  return { state, lookup, start, submitPhrase, reset };
}
