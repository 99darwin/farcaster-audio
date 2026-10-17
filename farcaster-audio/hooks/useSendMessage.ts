/**
 * Optimistic send with retry (design §6). The client generates the
 * `message_id`, so the upstream send is idempotent and a retry reuses the
 * same id; the server echo is merged onto the optimistic row by id.
 *
 * For a brand-new 1:1 the thread lives under a draft key until the first
 * send returns the real `conversation_id`, then moves there. Sends from a
 * draft are serialized so only the first one creates the conversation;
 * later ones wait and then target the real id. Every store write resolves
 * the thread key at that moment, because the draft may have been adopted
 * while the request was in flight.
 */

import { useCallback } from "react";
import { randomUUID } from "expo-crypto";
import { sendMessage } from "@/services/messagesApi";
import { resolveThreadKey, useMessageStore } from "@/stores/messageStore";
import { describeMessagesError, describeMessagesFailure } from "@/utils/messagesErrors";
import { haptic } from "@/utils/haptics";
import {
  MAX_MESSAGE_LENGTH,
  type Message,
  type MessageQuote,
  type MessageUser,
} from "@/types/messages";

/** Per-draft-key tail of the send queue. */
const draftSendQueues = new Map<string, Promise<unknown>>();

/** Run `task` after every earlier task queued under `key`. */
export function enqueueDraftSend<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = draftSendQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => undefined);
  draftSendQueues.set(key, tail);
  void tail.then(() => {
    if (draftSendQueues.get(key) === tail) draftSendQueues.delete(key);
  });
  return run;
}

/**
 * Optimistic `sent_at`: the device clock, but never at or before the newest
 * loaded message, so a skewed clock can't sort a new send above-history.
 */
export function clampOptimisticSentAt(now: number, newestLoaded: Message | undefined): number {
  if (!newestLoaded) return now;
  return Math.max(now, newestLoaded.sent_at + 1);
}

export interface UseSendMessageOptions {
  threadKey: string;
  conversationId: string | null;
  /** Needed only while `conversationId` is null (first DM to someone). */
  recipientFid: number | null;
  viewer: MessageUser | null;
  /** Called once a draft thread receives its real id. */
  onConversationCreated?: (conversationId: string) => void;
}

export interface SendResult {
  isSent: boolean;
  errorMessage: string | null;
}

export interface UseSendMessageResult {
  send: (
    text: string,
    replyTo: Message | null,
    options?: { processMetadata?: boolean },
  ) => Promise<SendResult>;
  retry: (message: Message) => Promise<SendResult>;
  discard: (message: Message) => void;
}

function toQuote(message: Message): MessageQuote {
  return {
    message_id: message.message_id,
    sender: message.sender,
    text: message.text,
    is_deleted: message.is_deleted,
  };
}

function buildOptimisticMessage({
  messageId,
  threadKey,
  viewer,
  text,
  replyTo,
  sentAt,
}: {
  messageId: string;
  threadKey: string;
  viewer: MessageUser;
  text: string;
  replyTo: Message | null;
  sentAt: number;
}): Message {
  return {
    message_id: messageId,
    conversation_id: threadKey,
    sender: viewer,
    type: "text",
    text,
    sent_at: sentAt,
    reactions: [],
    in_reply_to: replyTo ? toQuote(replyTo) : null,
    metadata: null,
    is_deleted: false,
    is_pinned: false,
    is_last_read: false,
    send_state: "sending",
  };
}

export function useSendMessage({
  threadKey,
  conversationId,
  recipientFid,
  viewer,
  onConversationCreated,
}: UseSendMessageOptions): UseSendMessageResult {
  const deliverNow = useCallback(
    async (
      message: Message,
      processMetadata: boolean,
      knownConversationId: string | null,
    ): Promise<SendResult> => {
      const liveKey = resolveThreadKey(threadKey);
      const adoptedId = liveKey !== threadKey ? liveKey : null;
      const targetId = knownConversationId ?? adoptedId;
      if (!targetId && !recipientFid) {
        useMessageStore.getState().markSendFailed(liveKey, message.message_id);
        return { isSent: false, errorMessage: describeMessagesError("unknown") };
      }
      try {
        const response = await sendMessage({
          conversation_id: targetId,
          recipient_fids: targetId ? [] : [recipientFid as number],
          message_id: message.message_id,
          text: message.text,
          in_reply_to_id: message.in_reply_to?.message_id ?? null,
          process_metadata: processMetadata,
        });
        const sent = response.message;
        const latest = useMessageStore.getState();
        if (!targetId) {
          latest.adoptDraftThread(threadKey, sent.conversation_id);
          latest.confirmSentMessage(sent.conversation_id, sent);
          onConversationCreated?.(sent.conversation_id);
        } else {
          latest.confirmSentMessage(resolveThreadKey(threadKey), sent);
        }
        return { isSent: true, errorMessage: null };
      } catch (error) {
        // Every failure, an `upstream_rejected` refusal included, leaves the
        // row "failed" for a manual retry; nothing here re-sends on its own.
        const errorMessage =
          describeMessagesFailure(error) ?? describeMessagesError("unknown");
        useMessageStore
          .getState()
          .markSendFailed(resolveThreadKey(threadKey), message.message_id);
        haptic.error();
        return { isSent: false, errorMessage };
      }
    },
    [onConversationCreated, recipientFid, threadKey],
  );

  const deliver = useCallback(
    (message: Message, processMetadata = true): Promise<SendResult> => {
      if (conversationId) return deliverNow(message, processMetadata, conversationId);
      return enqueueDraftSend(threadKey, () => deliverNow(message, processMetadata, null));
    },
    [conversationId, deliverNow, threadKey],
  );

  const send = useCallback(
    async (
      rawText: string,
      replyTo: Message | null,
      options: { processMetadata?: boolean } = {},
    ): Promise<SendResult> => {
      const text = rawText.trim();
      if (!text || !viewer) return { isSent: false, errorMessage: null };
      if (text.length > MAX_MESSAGE_LENGTH) {
        return {
          isSent: false,
          errorMessage: `Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`,
        };
      }
      const liveKey = resolveThreadKey(threadKey);
      const store = useMessageStore.getState();
      const optimistic = buildOptimisticMessage({
        messageId: randomUUID(),
        threadKey: liveKey,
        viewer,
        text,
        replyTo,
        sentAt: clampOptimisticSentAt(Date.now(), store.threads[liveKey]?.messages[0]),
      });
      store.upsertMessage(liveKey, optimistic);
      haptic.light();
      return deliver(optimistic, options.processMetadata ?? true);
    },
    [deliver, threadKey, viewer],
  );

  const retry = useCallback(
    async (message: Message): Promise<SendResult> => {
      if (message.send_state !== "failed") {
        return { isSent: false, errorMessage: null };
      }
      useMessageStore
        .getState()
        .patchMessage(resolveThreadKey(threadKey), message.message_id, {
          send_state: "sending",
        });
      return deliver({ ...message, send_state: "sending" });
    },
    [deliver, threadKey],
  );

  const discard = useCallback(
    (message: Message) => {
      if (!message.send_state) return;
      useMessageStore
        .getState()
        .removeMessage(resolveThreadKey(threadKey), message.message_id);
    },
    [threadKey],
  );

  return { send, retry, discard };
}
