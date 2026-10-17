import { EmptyState } from "@/components/ui/empty-state";
import { ChatBubbleIcon } from "@/components/messages/icons";

/**
 * Inbox route. The conversation list lives in the layout's inbox pane; this
 * fills the thread pane on wide screens until a conversation is picked.
 */
export default function MessagesIndexPage() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <EmptyState
        icon={<ChatBubbleIcon className="h-8 w-8" />}
        title="Pick a conversation"
        description="Choose a chat from the list, or start a new one. Press Ctrl/⌘ K to search."
      />
    </div>
  );
}
