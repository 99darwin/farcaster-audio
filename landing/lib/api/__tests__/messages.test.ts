import { ApiFetchError, apiFetch } from "@/lib/api/client";
import {
  INVALID_CURSOR,
  UPSTREAM_REJECTED,
  UPSTREAM_REJECTED_FALLBACK_COPY,
  createMessagesEventsTicket,
  isInvalidCursorError,
  isUpstreamRejectedError,
  messagingErrorCopy,
  upstreamRejectedCopy,
  acceptConversation,
  addReaction,
  declineConversation,
  getConversationWith,
  isConversationNotFoundError,
  MAX_MESSAGE_LENGTH,
  MESSAGING_DISABLED,
  buildQuery,
  deleteMessage,
  enableMessaging,
  getConversation,
  getInbox,
  getMessagingStatus,
  getMessages,
  getReactors,
  getRecentMessages,
  isMessagingDisabledError,
  isRateLimitedError,
  isMessagingTokenError,
  markConversationRead,
  markConversationUnread,
  previewMetadata,
  removeReaction,
  searchConversations,
  searchMessages,
  searchRecipients,
  sendMessage,
  MESSAGING_TOKEN_EXPIRED,
  MESSAGING_TOKEN_MISSING,
  MESSAGING_TOKEN_REJECTED,
  MESSAGING_TOKEN_UNAVAILABLE,
} from "@/lib/api/messages";

jest.mock("@/lib/api/client", () => {
  const actual = jest.requireActual("@/lib/api/client");
  return { ...actual, apiFetch: jest.fn() };
});
jest.mock("@/lib/auth/session", () => ({ getJwt: jest.fn(() => null) }));
jest.mock("@/lib/auth/authRefresh", () => ({ refreshSession: jest.fn() }));

const mockApiFetch = apiFetch as jest.MockedFunction<typeof apiFetch>;

beforeEach(() => {
  mockApiFetch.mockReset();
  mockApiFetch.mockResolvedValue(undefined);
});

describe("buildQuery", () => {
  it("drops empty values and encodes the rest", () => {
    expect(buildQuery({ a: 1, b: null, c: undefined, d: "", e: "x y" })).toBe("?a=1&e=x+y");
    expect(buildQuery({ a: null })).toBe("");
  });
});

describe("inbox + conversations", () => {
  it("requests the default inbox with the page size", async () => {
    await getInbox();
    expect(mockApiFetch).toHaveBeenCalledWith("/v1/messages/inbox?category=default&limit=25");
  });

  it("passes category, filter and cursor", async () => {
    await getInbox({ category: "request", filter: "unread", cursor: "abc", limit: 10 });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/v1/messages/inbox?category=request&filter=unread&cursor=abc&limit=10",
    );
  });

  it("encodes conversation ids in paths", async () => {
    await getConversation("a/b");
    expect(mockApiFetch).toHaveBeenCalledWith("/v1/messages/conversations/a%2Fb");
  });

  it("pages messages by cursor or anchor", async () => {
    await getMessages("c1", { cursor: "older" });
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/conversations/c1/messages?cursor=older&limit=30");
    await getMessages("c1", { anchorMessageId: "m9" });
    expect(mockApiFetch).toHaveBeenLastCalledWith(
      "/v1/messages/conversations/c1/messages?anchor_message_id=m9&limit=30",
    );
    await getRecentMessages("c1");
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/conversations/c1/recent");
  });

  it("marks read and unread with POST", async () => {
    await markConversationRead("c1");
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/conversations/c1/read", { method: "POST" });
    await markConversationUnread("c1");
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/conversations/c1/unread", { method: "POST" });
  });
});

describe("direct conversations + requests", () => {
  it("looks up the 1:1 with a fid", async () => {
    await getConversationWith(42);
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/conversations/with/42");
  });

  it("accepts and declines requests with POST", async () => {
    await acceptConversation("c 1");
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/conversations/c%201/accept", { method: "POST" });
    await declineConversation("c1");
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/conversations/c1/decline", { method: "POST" });
  });

  it("shares the max message length from the contract", () => {
    expect(MAX_MESSAGE_LENGTH).toBe(2000);
  });
});

describe("messages + reactions", () => {
  it("sends with PUT and the request body", async () => {
    const request = {
      conversation_id: "c1",
      recipient_fids: [],
      message_id: "m1",
      text: "hi",
      in_reply_to_id: null,
    };
    await sendMessage(request);
    expect(mockApiFetch).toHaveBeenCalledWith("/v1/messages/send", { method: "PUT", body: request });
  });

  it("deletes a message", async () => {
    await deleteMessage("c1", "m#1");
    expect(mockApiFetch).toHaveBeenCalledWith("/v1/messages/conversations/c1/messages/m%231", {
      method: "DELETE",
    });
  });

  it("adds and removes reactions", async () => {
    const body = { conversation_id: "c1", message_id: "m1", reaction: "🔥" };
    await addReaction(body);
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/reactions", { method: "PUT", body });
    await removeReaction(body);
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/reactions", { method: "DELETE", body });
  });

  it("lists reactors", async () => {
    await getReactors({ conversationId: "c1", messageId: "m1", cursor: "n" });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/v1/messages/reactions?conversation_id=c1&message_id=m1&cursor=n&limit=50",
    );
  });
});

describe("search + recipients + metadata", () => {
  it("scopes message search to a conversation", async () => {
    await searchMessages({ q: "pizza", conversationId: "a/b", cursor: "k" });
    expect(mockApiFetch).toHaveBeenLastCalledWith(
      "/v1/messages/search?q=pizza&conversation_id=a%2Fb&cursor=k&limit=20",
      { signal: undefined },
    );
  });

  it("searches messages, conversations and recipients", async () => {
    const signal = new AbortController().signal;
    await searchMessages({ q: "pizza", signal });
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/search?q=pizza&limit=20", { signal });
    await searchConversations({ q: "crew", limit: 5 });
    expect(mockApiFetch).toHaveBeenLastCalledWith(
      "/v1/messages/search/conversations?q=crew&category=default&limit=5",
      { signal: undefined },
    );
    await searchRecipients({ q: "ali" });
    expect(mockApiFetch).toHaveBeenLastCalledWith("/v1/messages/recipients?q=ali&limit=20", {
      signal: undefined,
    });
  });

  it("previews metadata with POST", async () => {
    await previewMetadata("see https://x.y");
    expect(mockApiFetch).toHaveBeenCalledWith("/v1/messages/metadata/preview", {
      method: "POST",
      body: { text: "see https://x.y" },
      signal: undefined,
    });
  });
});

describe("error classifiers", () => {
  it("recognises Direct Cast token errors", () => {
    for (const detail of [MESSAGING_TOKEN_MISSING, MESSAGING_TOKEN_EXPIRED, MESSAGING_TOKEN_REJECTED]) {
      expect(isMessagingTokenError(new ApiFetchError(403, detail))).toBe(true);
    }
    expect(isMessagingTokenError(new ApiFetchError(403, "signer_not_linked"))).toBe(false);
    expect(isMessagingTokenError(new ApiFetchError(503, MESSAGING_TOKEN_UNAVAILABLE))).toBe(false);
    expect(isMessagingTokenError(new ApiFetchError(403, "forbidden"))).toBe(false);
    expect(isMessagingTokenError(new Error("nope"))).toBe(false);
  });

  it("recognises the disabled flag and rate limits", () => {
    expect(isMessagingDisabledError(new ApiFetchError(404, MESSAGING_DISABLED))).toBe(true);
    // A per-resource 404 is a miss, never "feature off" (design doc 4.6).
    expect(isMessagingDisabledError(new ApiFetchError(404))).toBe(false);
    expect(isMessagingDisabledError(new ApiFetchError(404, "conversation_not_found"))).toBe(false);
    expect(isConversationNotFoundError(new ApiFetchError(404, "conversation_not_found"))).toBe(true);
    expect(isConversationNotFoundError(new ApiFetchError(404, "not_found"))).toBe(true);
    expect(isConversationNotFoundError(new ApiFetchError(404))).toBe(true);
    expect(isConversationNotFoundError(new ApiFetchError(404, MESSAGING_DISABLED))).toBe(false);
    expect(isConversationNotFoundError(new ApiFetchError(400, "not_found"))).toBe(false);
    expect(isMessagingDisabledError(new ApiFetchError(500))).toBe(false);
    expect(isRateLimitedError(new ApiFetchError(429))).toBe(true);
    expect(isRateLimitedError(null)).toBe(false);
  });
});

describe("messaging access", () => {
  it("reads the token status", async () => {
    const status = { enabled: true, signer_status: "ready", token_status: "expired", expires_at: null };
    mockApiFetch.mockResolvedValueOnce(status);
    await expect(getMessagingStatus()).resolves.toEqual(status);
    expect(mockApiFetch).toHaveBeenCalledWith("/v1/messages/status", { signal: undefined });
  });

  it("posts the signed token request to enable", async () => {
    const body = {
      dc_auth_request: {
        method: "generateToken" as const,
        params: { timestamp: 1, expiresAt: 2 },
      },
      dc_auth_signature: "eip191:AAAA",
    };
    await enableMessaging(body);
    expect(mockApiFetch).toHaveBeenCalledWith("/v1/messages/enable", { method: "POST", body });
  });

  it("surfaces enable errors", async () => {
    mockApiFetch.mockRejectedValueOnce(new ApiFetchError(400, "invalid_signature"));
    await expect(
      enableMessaging({
        dc_auth_request: { method: "generateToken", params: { timestamp: 1, expiresAt: 2 } },
        dc_auth_signature: "eip191:AAAA",
      }),
    ).rejects.toMatchObject({ status: 400, detail: "invalid_signature" });
  });
});

describe("upstream_rejected (422)", () => {
  it("is recognised only as a 422 with that detail", () => {
    expect(isUpstreamRejectedError(new ApiFetchError(422, UPSTREAM_REJECTED))).toBe(true);
    // FastAPI validation 422s are a different error.
    expect(isUpstreamRejectedError(new ApiFetchError(422, "[object]"))).toBe(false);
    expect(isUpstreamRejectedError(new ApiFetchError(400, UPSTREAM_REJECTED))).toBe(false);
    expect(isUpstreamRejectedError(new Error(UPSTREAM_REJECTED))).toBe(false);
  });

  it("shows upstream's message when present, else clear fallback copy", () => {
    const withMessage = new ApiFetchError(422, UPSTREAM_REJECTED, "Recipient does not accept messages");
    expect(upstreamRejectedCopy(withMessage)).toBe("Recipient does not accept messages");
    expect(upstreamRejectedCopy(new ApiFetchError(422, UPSTREAM_REJECTED))).toBe(
      UPSTREAM_REJECTED_FALLBACK_COPY,
    );
    expect(upstreamRejectedCopy(new ApiFetchError(422, UPSTREAM_REJECTED, "   "))).toBe(
      UPSTREAM_REJECTED_FALLBACK_COPY,
    );
  });

  it("maps to user copy that never reads as an outage or leaks raw API text", () => {
    const rejected = new ApiFetchError(422, UPSTREAM_REJECTED, "Message too long");
    expect(messagingErrorCopy(rejected, "Couldn't send")).toBe("Message too long");
    expect(messagingErrorCopy(new ApiFetchError(429, "rate_limited"), "x")).toBe(
      "Slow down a little, then try again.",
    );
    expect(messagingErrorCopy(new ApiFetchError(502, "upstream_error"), "Couldn't send")).toBe(
      "Couldn't send",
    );
    expect(messagingErrorCopy(new Error("Network down"), "Couldn't send")).toBe("Network down");
    expect(messagingErrorCopy("weird", "Couldn't send")).toBe("Couldn't send");
  });
});

describe("invalid_cursor (400)", () => {
  it("is recognised only as a 400 with that detail", () => {
    expect(isInvalidCursorError(new ApiFetchError(400, INVALID_CURSOR))).toBe(true);
    expect(isInvalidCursorError(new ApiFetchError(400, "invalid_recipient"))).toBe(false);
    expect(isInvalidCursorError(new ApiFetchError(422, INVALID_CURSOR))).toBe(false);
  });
});

describe("events ticket", () => {
  it("mints with POST and leaves the 401 decision to the socket layer", async () => {
    mockApiFetch.mockResolvedValueOnce({ ticket: "t", expires_in: 30 });
    await expect(createMessagesEventsTicket()).resolves.toEqual({ ticket: "t", expires_in: 30 });
    expect(mockApiFetch).toHaveBeenCalledWith("/v1/messages/events/ticket", {
      method: "POST",
      skipAuthRefresh: true,
    });
  });
});
