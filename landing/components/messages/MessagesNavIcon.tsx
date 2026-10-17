"use client";

import { formatBadgeCount } from "@/lib/messages/format";
import { useMessageStore } from "@/lib/stores/messageStore";
import { ChatBubbleIcon } from "./icons";
import { useInboxBackgroundPoll, useMessagingSession } from "./useMessagingSync";

/**
 * Messages nav icon with its own unread badge. The shared nav's
 * `showsUnreadBadge` slot is wired to the notification count, so this icon
 * renders the messages badge itself (the nav wraps every icon in a
 * `relative` span, which positions the badge the same way).
 */
export function MessagesNavIcon({ className }: { className?: string }) {
  const access = useMessagingSession();
  const unread = useMessageStore((s) => s.unreadTotal);
  const hasUnreadRequests = useMessageStore((s) => s.hasUnreadRequests);
  useInboxBackgroundPoll(access === "ready");

  const showCount = access === "ready" && unread > 0;
  const showDot = access === "ready" && !showCount && hasUnreadRequests;

  return (
    <>
      <ChatBubbleIcon className={className} />
      {showCount && (
        <span className="absolute -right-1.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-juke-orange px-1 text-[10px] font-bold leading-none text-white">
          <span aria-hidden>{formatBadgeCount(unread)}</span>
          <span className="sr-only">, {unread} unread</span>
        </span>
      )}
      {showDot && (
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-juke-purple">
          <span className="sr-only">, new message requests</span>
        </span>
      )}
    </>
  );
}
