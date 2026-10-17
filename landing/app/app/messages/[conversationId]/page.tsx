"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ThreadView } from "@/components/messages/ThreadView";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { MESSAGES_INBOX_PATH, decodeConversationParam } from "@/lib/messages/deep-link";

/** `/app/messages/{conversationId}?m={messageId}` thread route. */
export default function ConversationPage() {
  const params = useParams<{ conversationId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  // A malformed escape in the URL must not crash the route with a URIError.
  const conversationId = decodeConversationParam(params?.conversationId);
  const messageId = searchParams?.get("m") ?? null;

  if (!conversationId) {
    return (
      <section aria-label="Conversation not found" className="flex h-full min-h-0 w-full flex-col bg-juke-navy">
        <EmptyState
          className="flex-1"
          title="Conversation not found"
          description="That link doesn't point to a conversation."
          action={
            <Button variant="secondary" onClick={() => router.push(MESSAGES_INBOX_PATH)}>
              Back to messages
            </Button>
          }
        />
      </section>
    );
  }

  // Re-key on the conversation so per-thread view state (unread divider,
  // search, scroll) never leaks between conversations.
  return <ThreadView key={conversationId} conversationId={conversationId} initialMessageId={messageId} />;
}
