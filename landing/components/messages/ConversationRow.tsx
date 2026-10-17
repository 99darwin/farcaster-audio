"use client";

import { memo } from "react";
import Link from "next/link";
import type { Conversation } from "@/lib/api/messages.types";
import { conversationHref } from "@/lib/messages/deep-link";
import {
  conversationAvatar,
  conversationTitle,
  formatBadgeCount,
  formatInboxTime,
  lastMessagePreview,
} from "@/lib/messages/format";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/components/ui/cn";
import { RequestActions } from "./RequestActions";
import { MutedGlyph, PinGlyph } from "./icons";

export interface ConversationRowProps {
  conversation: Conversation;
  viewerFid: number | null;
  isActive: boolean;
  now: number;
  /** Roving tabindex inside the inbox list. */
  tabIndex: 0 | -1;
  onToggleRead: (conversation: Conversation) => void;
  /** Requests segment: render Accept/Decline; errors surface through this. */
  onRequestError?: (message: string) => void;
}

/**
 * One inbox row: avatar, title, time, last-message preview and unread /
 * mention badges. The row is a link; "Mark read/unread" is a sibling button
 * revealed on hover/focus so links never nest interactive content.
 */
export const ConversationRow = memo(function ConversationRow({
  conversation,
  viewerFid,
  isActive,
  now,
  tabIndex,
  onToggleRead,
  onRequestError,
}: ConversationRowProps) {
  const title = conversationTitle(conversation, viewerFid);
  const avatar = conversationAvatar(conversation, viewerFid);
  const preview = lastMessagePreview(conversation.last_message, viewerFid, conversation.is_group);
  const isUnread = conversation.unread_count > 0 || conversation.manually_marked_unread;
  const time = conversation.last_message ? formatInboxTime(conversation.last_message.sent_at, now) : "";
  const unreadLabel = conversation.unread_count > 0 ? `${conversation.unread_count} unread` : isUnread ? "unread" : "";

  return (
    <div className="group relative" data-conversation-id={conversation.conversation_id}>
      <Link
        href={conversationHref(conversation.conversation_id)}
        aria-current={isActive ? "page" : undefined}
        tabIndex={tabIndex}
        data-inbox-row
        aria-label={[title, unreadLabel, conversation.muted ? "muted" : "", preview, time]
          .filter(Boolean)
          .join(", ")}
        className={cn(
          "flex items-center gap-3 px-4 py-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-juke-orange",
          isActive ? "bg-juke-surface" : "hover:bg-juke-surface/60",
        )}
      >
        <Avatar src={avatar.src} name={avatar.name} size="md" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[15px] text-juke-text-on-dark",
                isUnread ? "font-bold" : "font-semibold",
              )}
            >
              {title}
            </span>
            {conversation.pinned && <PinGlyph className="h-3.5 w-3.5 shrink-0 text-juke-text-on-dark-tertiary" />}
            {conversation.muted && <MutedGlyph className="h-3.5 w-3.5 shrink-0 text-juke-text-on-dark-tertiary" />}
            <span
              className={cn(
                "shrink-0 text-xs tabular-nums",
                isUnread && !conversation.muted ? "text-juke-orange" : "text-juke-text-on-dark-tertiary",
              )}
            >
              {time}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-sm",
                isUnread ? "text-juke-text-on-dark" : "text-juke-text-on-dark-secondary",
              )}
            >
              {preview}
            </span>
            {conversation.unread_mentions_count > 0 && (
              <span
                aria-hidden="true"
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-juke-purple text-[11px] font-bold text-white"
              >
                @
              </span>
            )}
            {conversation.unread_count > 0 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums",
                  conversation.muted ? "bg-juke-border text-juke-text-on-dark-secondary" : "bg-juke-orange text-white",
                )}
              >
                {formatBadgeCount(conversation.unread_count)}
              </span>
            ) : isUnread ? (
              <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-juke-orange" />
            ) : null}
          </span>
        </span>
      </Link>
      {/* Follows the row's roving tabindex: Tab from the focused row reaches it
          (focus-within reveals it before the browser moves focus). */}
      <button
        type="button"
        tabIndex={tabIndex}
        onClick={() => onToggleRead(conversation)}
        aria-label={`${isUnread ? "Mark read" : "Mark unread"}: ${title}`}
        className="absolute right-3 top-2 hidden rounded-full border border-juke-border bg-juke-navy px-2 py-0.5 text-[11px] font-semibold text-juke-text-on-dark-secondary hover:text-juke-text-on-dark focus-visible:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange group-hover:block group-focus-within:block"
      >
        {isUnread ? "Mark read" : "Mark unread"}
      </button>
      {onRequestError && conversation.category === "request" && (
        <RequestActions
          conversationId={conversation.conversation_id}
          title={title}
          onError={onRequestError}
          tabIndex={tabIndex}
          className="pb-3 pl-[4.25rem] pr-4"
        />
      )}
    </div>
  );
});
