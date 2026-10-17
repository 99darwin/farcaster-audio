/**
 * Route helpers for messaging. A first DM to someone has no conversation id
 * yet, so it opens the thread screen under DRAFT_CONVERSATION_ROUTE with only
 * the recipient's fid in params; the screen swaps to the real id after the
 * first send. Names and avatars are never carried in params (any link can
 * set them); the thread screen resolves them by fid.
 *
 * Whether a DM already exists is asked of the server
 * (`GET /conversations/with/{fid}`), so the profile "Message" button works
 * even when the inbox page holding that conversation was never loaded.
 */

import type { Router } from "expo-router";
import { getConversationWith, MessagesApiError } from "@/services/messagesApi";
import { findDirectConversation, useMessageStore } from "@/stores/messageStore";
import { describeMessagesError } from "@/utils/messagesErrors";
import type { MessageUser } from "@/types/messages";
import { rememberDraftRecipient } from "@/hooks/useDraftRecipient";

/** Must not collide with the static `messages/new` and `messages/search` routes. */
export const DRAFT_CONVERSATION_ROUTE = "draft";

/** A type alias (not an interface) so it satisfies expo-router's param constraint. */
export type ThreadRouteParams = {
  conversationId: string;
  recipientFid?: string;
  anchorMessageId?: string;
};

export function threadHref(params: ThreadRouteParams) {
  return { pathname: "/messages/[conversationId]" as const, params: { ...params } };
}

/**
 * - `opened`: navigated to the existing thread or a draft.
 * - `invalid_recipient`: the server refused (e.g. messaging yourself).
 * - `busy`: a lookup for this fid is already running (double tap).
 */
export type OpenDirectThreadResult = "opened" | "invalid_recipient" | "busy";

const pendingLookups = new Set<number>();

function draftHref(user: MessageUser) {
  // In-app taps already hold the profile; hand it over in memory so the
  // draft header renders instantly without trusting route params.
  rememberDraftRecipient(user);
  return threadHref({
    conversationId: DRAFT_CONVERSATION_ROUTE,
    recipientFid: String(user.fid),
  });
}

/**
 * Open the 1:1 thread with `user`. A conversation already in the store
 * opens instantly; otherwise the server is asked. `not_found` (and any
 * transient failure) opens a draft: the first send creates or reuses the
 * conversation server-side either way.
 */
export async function openDirectThread(
  router: Pick<Router, "push" | "replace">,
  user: MessageUser,
  options: { shouldReplace?: boolean } = {},
): Promise<OpenDirectThreadResult> {
  const navigate = (href: ReturnType<typeof threadHref>) => {
    if (options.shouldReplace) router.replace(href);
    else router.push(href);
  };
  const known = findDirectConversation(useMessageStore.getState().conversations, user.fid);
  if (known) {
    navigate(threadHref({ conversationId: known.conversation_id }));
    return "opened";
  }
  if (pendingLookups.has(user.fid)) return "busy";
  pendingLookups.add(user.fid);
  try {
    const conversation = await getConversationWith(user.fid);
    useMessageStore.getState().upsertConversation(conversation);
    navigate(threadHref({ conversationId: conversation.conversation_id }));
    return "opened";
  } catch (error) {
    if (error instanceof MessagesApiError && error.code === "invalid_recipient") {
      return "invalid_recipient";
    }
    navigate(draftHref(user));
    return "opened";
  } finally {
    pendingLookups.delete(user.fid);
  }
}

/** `openDirectThread` for button handlers: explains a refusal to the user. */
export async function openDirectThreadWithFeedback(
  router: Pick<Router, "push" | "replace">,
  user: MessageUser,
  options: { shouldReplace?: boolean; onRefused: (message: string) => void },
): Promise<void> {
  const result = await openDirectThread(router, user, options);
  if (result === "invalid_recipient") {
    options.onRefused(describeMessagesError("invalid_recipient"));
  }
}
