/**
 * Optimistic reaction toggle (design §6): flip `viewer_reacted` locally,
 * then PUT/DELETE upstream, reverting on failure.
 */

import { useCallback } from "react";
import { addReaction, removeReaction } from "@/services/messagesApi";
import { useMessageStore } from "@/stores/messageStore";
import { describeMessagesFailure } from "@/utils/messagesErrors";
import { haptic } from "@/utils/haptics";
import type { Message } from "@/types/messages";

export interface UseMessageReactionsResult {
  /** Resolves to a user-facing error message, or null on success or abort. */
  toggleReaction: (message: Message, reaction: string) => Promise<string | null>;
}

export function useMessageReactions(
  conversationId: string | null,
): UseMessageReactionsResult {
  const toggleReaction = useCallback(
    async (message: Message, reaction: string) => {
      // Optimistic and deleted messages can't carry reactions upstream.
      if (!conversationId || message.send_state || message.is_deleted) {
        return null;
      }
      const isAdding = !message.reactions.some(
        (r) => r.reaction === reaction && r.viewer_reacted,
      );
      const store = useMessageStore.getState();
      store.applyReaction(conversationId, message.message_id, reaction, isAdding);
      haptic.selection();
      const body = {
        conversation_id: conversationId,
        message_id: message.message_id,
        reaction,
      };
      try {
        if (isAdding) await addReaction(body);
        else await removeReaction(body);
        return null;
      } catch (error) {
        useMessageStore
          .getState()
          .applyReaction(conversationId, message.message_id, reaction, !isAdding);
        // Includes Farcaster's own reason for an `upstream_rejected` 422.
        return describeMessagesFailure(error);
      }
    },
    [conversationId],
  );

  return { toggleReaction };
}
