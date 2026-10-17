import type { Conversation, Message, MessageUser } from "@/lib/api/messages.types";

export const ALICE: MessageUser = { fid: 1, username: "alice", display_name: "Alice", pfp_url: null };
export const BOB: MessageUser = { fid: 2, username: "bob", display_name: "Bob", pfp_url: "https://example.com/bob.png" };

export const BASE_TIME = new Date(2026, 9, 16, 12, 0, 0).getTime();
export const MINUTE = 60_000;

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: "m1",
    conversation_id: "c1",
    sender: BOB,
    type: "text",
    text: "hello",
    sent_at: BASE_TIME,
    reactions: [],
    in_reply_to: null,
    metadata: null,
    is_deleted: false,
    is_pinned: false,
    is_last_read: false,
    ...overrides,
  };
}

export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    conversation_id: "c1",
    is_group: false,
    name: null,
    photo_url: null,
    participants: [ALICE, BOB],
    counterparty: BOB,
    last_message: null,
    unread_count: 0,
    unread_mentions_count: 0,
    muted: false,
    pinned: false,
    archived: false,
    category: "default",
    access: "read-write",
    last_read_at: 0,
    manually_marked_unread: false,
    created_at: 0,
    ...overrides,
  };
}
