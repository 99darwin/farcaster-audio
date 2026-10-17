/**
 * Who a draft DM (`/messages/draft?recipientFid=<n>`) is addressed to.
 *
 * The draft route is reachable from any `juke://` link, so the recipient's
 * name and avatar are never taken from route params: a link could pair one
 * person's fid with someone else's name. The identity comes from the
 * profile API, or from the in-memory copy that `openDirectThread` leaves
 * when the user taps "Message" inside the app (so that path stays instant).
 */

import { useEffect, useState } from "react";
import * as api from "@/services/api";
import type { MessageUser } from "@/types/messages";

const MAX_REMEMBERED_RECIPIENTS = 50;
const rememberedRecipients = new Map<number, MessageUser>();

/** Called only by in-app navigation with a profile Juke already loaded. */
export function rememberDraftRecipient(user: MessageUser): void {
  rememberedRecipients.delete(user.fid);
  rememberedRecipients.set(user.fid, user);
  if (rememberedRecipients.size > MAX_REMEMBERED_RECIPIENTS) {
    const oldest = rememberedRecipients.keys().next().value;
    if (oldest !== undefined) rememberedRecipients.delete(oldest);
  }
}

/** Test-only reset of the in-memory recipient cache. */
export function __resetRememberedDraftRecipients(): void {
  rememberedRecipients.clear();
}

interface ProfileResponse {
  user?: {
    fid?: number;
    username?: string | null;
    display_name?: string | null;
    pfp_url?: string | null;
  };
}

function toMessageUser(fid: number, data: ProfileResponse): MessageUser | null {
  const user = data?.user;
  if (!user || user.fid !== fid) return null;
  return {
    fid,
    username: user.username || null,
    display_name: user.display_name ?? "",
    pfp_url: user.pfp_url || null,
  };
}

export interface DraftRecipientState {
  recipient: MessageUser | null;
  /** True until the profile resolves (or fails); render a skeleton meanwhile. */
  isLoading: boolean;
}

export function useDraftRecipient(fid: number | null): DraftRecipientState {
  const [state, setState] = useState<DraftRecipientState>(() => {
    const remembered = fid ? rememberedRecipients.get(fid) : undefined;
    return { recipient: remembered ?? null, isLoading: !!fid && !remembered };
  });

  useEffect(() => {
    if (!fid) {
      setState({ recipient: null, isLoading: false });
      return;
    }
    const remembered = rememberedRecipients.get(fid);
    if (remembered) {
      setState({ recipient: remembered, isLoading: false });
      return;
    }
    let isCancelled = false;
    setState({ recipient: null, isLoading: true });
    api
      .getUserProfile(fid)
      .then((data: ProfileResponse) => {
        if (isCancelled) return;
        setState({ recipient: toMessageUser(fid, data), isLoading: false });
      })
      .catch(() => {
        if (!isCancelled) setState({ recipient: null, isLoading: false });
      });
    return () => {
      isCancelled = true;
    };
  }, [fid]);

  return state;
}
