/** Test builders for messaging types (not matched by jest's testMatch). */

import type { Conversation, Message, MessageUser } from "@/types/messages";

export const VIEWER: MessageUser = {
  fid: 1,
  username: "me",
  display_name: "Me",
  pfp_url: null,
};

export const ALICE: MessageUser = {
  fid: 2,
  username: "alice",
  display_name: "Alice",
  pfp_url: "https://example.com/alice.png",
};

export const BOB: MessageUser = {
  fid: 3,
  username: "bob",
  display_name: "Bob",
  pfp_url: null,
};

export const BASE_TIME = Date.UTC(2026, 9, 15, 12, 0, 0);

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: "m1",
    conversation_id: "c1",
    sender: ALICE,
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
    participants: [VIEWER, ALICE],
    counterparty: ALICE,
    last_message: makeMessage(),
    unread_count: 0,
    unread_mentions_count: 0,
    muted: false,
    pinned: false,
    archived: false,
    category: "default",
    access: "read-write",
    last_read_at: BASE_TIME,
    manually_marked_unread: false,
    created_at: BASE_TIME - 1000,
    ...overrides,
  };
}
