import { create } from "zustand";

/**
 * A single, app-wide "are you sure?" prompt used to put a deliberate user
 * tap in front of actions that untrusted content can otherwise trigger on
 * its own: leaving the app for an external URL, signing a mini app in,
 * launching a deep-linked mini app, or joining a deep-linked space.
 */
export interface ConfirmationRequest {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Exact target shown verbatim (URL, domain) so the user sees what they approve. */
  detail?: string;
}

interface PendingConfirmation {
  request: ConfirmationRequest;
  resolve: (isConfirmed: boolean) => void;
}

interface ConfirmationStore {
  pending: PendingConfirmation | null;
  /**
   * Resolves true only on an explicit confirm tap. A request made while
   * another is on screen resolves false immediately, so a page cannot
   * queue up prompts or swap the one the user is reading.
   */
  requestConfirmation: (request: ConfirmationRequest) => Promise<boolean>;
  resolveConfirmation: (isConfirmed: boolean) => void;
}

export const useConfirmationStore = create<ConfirmationStore>((set, get) => ({
  pending: null,

  requestConfirmation: (request) => {
    if (get().pending) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      set({ pending: { request, resolve } });
    });
  },

  resolveConfirmation: (isConfirmed) => {
    const current = get().pending;
    if (!current) return;
    set({ pending: null });
    current.resolve(isConfirmed);
  },
}));

/** Non-hook accessor for hook callbacks, services and deep-link handlers. */
export function requestConfirmation(
  request: ConfirmationRequest,
): Promise<boolean> {
  return useConfirmationStore.getState().requestConfirmation(request);
}
