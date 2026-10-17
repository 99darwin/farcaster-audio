/**
 * Web sign-in for the hosted embed, run in a first-party popup.
 *
 * The embed (`/embed/[id]`) can be framed by any site, so it never renders
 * the recovery-phrase field itself. Instead it opens `EMBED_SIGN_IN_PATH` on
 * its own origin in a top-level window: no third-party frame around it, and
 * first-party storage, so a browser already linked on juke.audio signs in
 * without the phrase. The popup hands back only the `LoginResponse` (JWT and
 * body refresh token, never key material) via `postMessage` to a
 * same-origin opener.
 *
 * Both ends check origin: the popup only posts to its own origin, and the
 * embed only accepts messages from its own origin sent by the window it
 * opened. A page on another origin that opens the popup receives nothing.
 */

import type { LoginResponse } from "@/lib/api/types";
import type { AuthApiOptions } from "@/lib/auth/protocolLogin";

export const EMBED_SIGN_IN_PATH = "/auth/embed-sign-in";
export const EMBED_SIGN_IN_MESSAGE_TYPE = "juke:embed-sign-in";

/**
 * Auth transport options for embed sessions: the refresh token comes back
 * in the response body and lives in the embed SDK's memory, because the
 * embed is a cross-origin iframe whose cookies are partitioned.
 */
export const EMBED_AUTH_OPTIONS: AuthApiOptions = Object.freeze({
  useCookie: false,
});

const POPUP_WINDOW_NAME = "juke-embed-sign-in";
const POPUP_FEATURES = "popup,width=440,height=680";
const POPUP_CLOSED_POLL_MS = 500;

export type EmbedSignInPopupFailure = "blocked" | "closed" | "aborted";

const POPUP_FAILURE_MESSAGES: Record<EmbedSignInPopupFailure, string> = {
  blocked: "Your browser blocked the sign-in window. Allow pop-ups and try again.",
  closed: "Sign-in window was closed.",
  aborted: "Sign-in was cancelled.",
};

export class EmbedSignInPopupError extends Error {
  readonly reason: EmbedSignInPopupFailure;

  constructor(reason: EmbedSignInPopupFailure) {
    super(POPUP_FAILURE_MESSAGES[reason]);
    this.name = "EmbedSignInPopupError";
    this.reason = reason;
  }
}

interface EmbedSignInMessage {
  type: typeof EMBED_SIGN_IN_MESSAGE_TYPE;
  response: LoginResponse;
}

/** Narrow an untrusted `postMessage` payload to a sign-in result. */
export function parseEmbedSignInMessage(data: unknown): LoginResponse | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, response } = data as { type?: unknown; response?: unknown };
  if (type !== EMBED_SIGN_IN_MESSAGE_TYPE) return null;
  if (typeof response !== "object" || response === null) return null;
  const { jwt, user } = response as { jwt?: unknown; user?: { fid?: unknown } };
  if (typeof jwt !== "string" || jwt.length === 0) return null;
  if (!Number.isSafeInteger(user?.fid)) return null;
  return response as LoginResponse;
}

export interface OpenEmbedSignInPopupOptions {
  signal?: AbortSignal;
  /** Injected in tests; defaults to `window`. */
  win?: Window;
}

/**
 * Open the sign-in popup and resolve with the session it mints. Call it
 * synchronously from a click handler, or the browser blocks the popup.
 *
 * @throws {EmbedSignInPopupError} when the popup is blocked, closed by the
 *   user, or `signal` aborts.
 */
export function openEmbedSignInPopup({
  signal,
  win = window,
}: OpenEmbedSignInPopupOptions = {}): Promise<LoginResponse> {
  if (signal?.aborted) {
    return Promise.reject(new EmbedSignInPopupError("aborted"));
  }
  const origin = win.location.origin;
  const popup = win.open(
    new URL(EMBED_SIGN_IN_PATH, origin).toString(),
    POPUP_WINDOW_NAME,
    POPUP_FEATURES,
  );
  if (!popup) return Promise.reject(new EmbedSignInPopupError("blocked"));

  return new Promise<LoginResponse>((resolve, reject) => {
    const cleanup = () => {
      win.removeEventListener("message", handleMessage);
      win.clearInterval(closedPoll);
      signal?.removeEventListener("abort", handleAbort);
    };
    const fail = (reason: EmbedSignInPopupFailure) => {
      cleanup();
      reject(new EmbedSignInPopupError(reason));
    };

    function handleMessage(event: MessageEvent) {
      if (event.origin !== origin || event.source !== popup) return;
      const response = parseEmbedSignInMessage(event.data);
      if (!response) return;
      cleanup();
      resolve(response);
    }

    function handleAbort() {
      popup?.close();
      fail("aborted");
    }

    win.addEventListener("message", handleMessage);
    signal?.addEventListener("abort", handleAbort);
    const closedPoll = win.setInterval(() => {
      if (popup.closed) fail("closed");
    }, POPUP_CLOSED_POLL_MS);
  });
}

/**
 * True when this window was opened by a page on the same origin, i.e. the
 * hosted embed. Reading `opener.location` throws for a cross-origin opener.
 */
export function hasSameOriginOpener(win: Window = window): boolean {
  const opener = win.opener as Window | null;
  if (!opener || opener === win) return false;
  try {
    return opener.location.origin === win.location.origin;
  } catch {
    return false;
  }
}

/** True when this window is inside a frame (the popup must be top-level). */
export function isFramed(win: Window = window): boolean {
  try {
    return win.top !== win.self;
  } catch {
    return true;
  }
}

/**
 * Hand the session to the opener. `targetOrigin` is our own origin, so a
 * cross-origin opener never receives it even if it navigated meanwhile.
 *
 * @returns false when there is no same-origin opener to receive it.
 */
export function postLoginResponseToOpener(
  response: LoginResponse,
  win: Window = window,
): boolean {
  if (!hasSameOriginOpener(win)) return false;
  const message: EmbedSignInMessage = {
    type: EMBED_SIGN_IN_MESSAGE_TYPE,
    response,
  };
  (win.opener as Window).postMessage(message, win.location.origin);
  return true;
}
