import { AxiosError, AxiosHeaders } from "axios";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockRequest = jest.fn<(config: Record<string, any>) => Promise<{ data: unknown }>>();

jest.mock("@/services/api", () => {
  const actual = jest.requireActual("@/services/api") as Record<string, unknown>;
  return {
    getApiErrorCode: actual.getApiErrorCode,
    apiClient: { request: (config: Record<string, any>) => mockRequest(config) },
  };
});

import {
  acceptConversationRequest,
  createMessagesEventsTicket,
  messagesEventsUrl,
  declineConversationRequest,
  EnableMessagingError,
  enableMessaging,
  getConversationWith,
  getInbox,
  getMessages,
  searchMessages,
  getMessagingStatus,
  isSignerError,
  MessagesApiError,
  sendMessage,
  toMessagingTokenError,
} from "@/services/messagesApi";

function httpError(status: number, detail?: string): AxiosError {
  return httpErrorWithData(status, detail ? { detail } : {});
}

function httpErrorWithData(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError("fail", "ERR", config as never, null, {
    status,
    statusText: "",
    headers: {},
    config: config as never,
    data,
  });
}

const EMPTY_INBOX = {
  items: [],
  next_cursor: null,
  requests_count: 0,
  has_unread_requests: false,
  has_archived: false,
};

describe("messagesApi", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("sends no Farcaster credential header (the backend holds the token)", async () => {
    mockRequest.mockResolvedValue({ data: EMPTY_INBOX });
    await getInbox();
    expect(mockRequest.mock.calls[0][0].headers).toBeUndefined();
    expect(mockRequest.mock.calls[0][0].params).toEqual({ category: "default", limit: 25 });
  });

  it("does not retry a rejected token", async () => {
    mockRequest.mockRejectedValue(httpError(403, "messaging_token_rejected"));
    await expect(
      sendMessage({
        conversation_id: "c1",
        recipient_fids: [],
        message_id: "m1",
        text: "hi",
        in_reply_to_id: null,
      }),
    ).rejects.toMatchObject({ code: "token_rejected" });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    [httpError(403, "messaging_token_missing"), "token_missing"],
    [httpError(403, "messaging_token_expired"), "token_expired"],
    [httpError(403, "messaging_token_rejected"), "token_rejected"],
    [httpError(403, "forbidden_other"), "unknown"],
    [httpError(429), "rate_limited"],
    [httpError(502), "upstream_error"],
    [httpError(500), "unknown"],
  ])("maps HTTP failures to typed codes (%#)", async (error, code) => {
    mockRequest.mockRejectedValue(error);
    await expect(getInbox()).rejects.toMatchObject({ code });
  });

  it("treats an inbox 404 as the feature being off", async () => {
    mockRequest.mockRejectedValue(httpError(404));
    const failure = await getInbox().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(MessagesApiError);
    expect((failure as MessagesApiError).code).toBe("unavailable");
  });

  it("maps a missing response to a network error", async () => {
    const config = { headers: new AxiosHeaders() };
    mockRequest.mockRejectedValue(new AxiosError("offline", "ERR_NETWORK", config as never));
    await expect(getInbox()).rejects.toMatchObject({ code: "network" });
  });

  it("classifies token errors for the enable gate", () => {
    expect(isSignerError(new MessagesApiError("token_expired", 403))).toBe(true);
    expect(isSignerError(new MessagesApiError("rate_limited", 429))).toBe(false);
    expect(toMessagingTokenError("messaging_token_expired")).toBe("token_expired");
    expect(toMessagingTokenError("")).toBe("token_missing");
    expect(toMessagingTokenError(undefined)).toBe("token_missing");
  });

  it("reads GET /status", async () => {
    const status = { enabled: true, signer_status: "ready", token_status: "active", expires_at: null };
    mockRequest.mockResolvedValue({ data: status });
    await expect(getMessagingStatus()).resolves.toEqual(status);
    expect(mockRequest.mock.calls[0][0]).toMatchObject({ method: "GET", url: "/v1/messages/status" });
  });

  describe("enableMessaging", () => {
    const body = {
      dc_auth_request: {
        method: "generateToken" as const,
        params: { timestamp: 1, expiresAt: 2 },
      },
      dc_auth_signature: "eip191:SECRET-SIGNATURE",
    };

    it("posts the signed request", async () => {
      mockRequest.mockResolvedValue({ data: { token_status: "active", expires_at: "2030-01-01T00:00:00Z" } });
      await expect(enableMessaging(body)).resolves.toEqual({
        token_status: "active",
        expires_at: "2030-01-01T00:00:00Z",
      });
      expect(mockRequest.mock.calls[0][0]).toMatchObject({
        method: "POST",
        url: "/v1/messages/enable",
        data: body,
      });
    });

    it.each([
      [httpError(400, "invalid_signature"), "invalid_signature"],
      [httpError(400, "invalid_auth_request"), "invalid_auth_request"],
      [httpError(429, "rate_limited"), "rate_limited"],
      [httpError(502, "registry_unavailable"), "upstream_error"],
      [httpError(404), "unavailable"],
      [httpError(500), "unknown"],
    ])("maps failures to typed codes without the body (%#)", async (error, code) => {
      mockRequest.mockRejectedValue(error);
      const failure = await enableMessaging(body).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(EnableMessagingError);
      expect((failure as EnableMessagingError).code).toBe(code);
      expect(JSON.stringify(failure)).not.toContain("SECRET-SIGNATURE");
      expect(String(failure)).not.toContain("SECRET-SIGNATURE");
    });
  });
});

describe("messagesApi contract additions", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("looks up a 1:1 conversation by fid", async () => {
    mockRequest.mockResolvedValue({ data: { conversation_id: "c1" } });
    await getConversationWith(42);
    expect(mockRequest.mock.calls[0][0]).toMatchObject({
      method: "GET",
      url: "/v1/messages/conversations/with/42",
    });
  });

  it("maps a missing 1:1 conversation to not_found", async () => {
    mockRequest.mockRejectedValue(httpError(404, "conversation_not_found"));
    const failure = await getConversationWith(42).catch((e: unknown) => e);
    expect((failure as MessagesApiError).code).toBe("not_found");
  });

  it("maps messaging_disabled to unavailable and invalid_recipient through", async () => {
    // A non-inbox route: only the detail distinguishes "feature off".
    mockRequest.mockRejectedValue(httpError(404, "messaging_disabled"));
    const disabled = await getMessages("c1").catch((e: unknown) => e);
    expect((disabled as MessagesApiError).code).toBe("unavailable");

    mockRequest.mockRejectedValue(httpError(400, "invalid_recipient"));
    const self = await getConversationWith(1).catch((e: unknown) => e);
    expect((self as MessagesApiError).code).toBe("invalid_recipient");
  });

  it("scopes search to a conversation", async () => {
    mockRequest.mockResolvedValue({ data: { items: [], next_cursor: null } });
    await searchMessages("coffee", { conversationId: "c1", cursor: "p2" });
    expect(mockRequest.mock.calls[0][0].params).toMatchObject({
      q: "coffee",
      conversation_id: "c1",
      cursor: "p2",
    });
  });

  it("omits conversation_id for global search", async () => {
    mockRequest.mockResolvedValue({ data: { items: [], next_cursor: null } });
    await searchMessages("coffee");
    expect(mockRequest.mock.calls[0][0].params).not.toHaveProperty("conversation_id");
  });

  it("returns the newer cursor from thread pages", async () => {
    mockRequest.mockResolvedValue({
      data: { items: [], next_cursor: "older", next_newer_cursor: "newer" },
    });
    const page = await getMessages("c1");
    expect(page.next_newer_cursor).toBe("newer");
  });

  it.each([
    [acceptConversationRequest, "accept"],
    [declineConversationRequest, "decline"],
  ])("posts request responses (%#)", async (call, action) => {
    mockRequest.mockResolvedValue({ data: undefined });
    await call("c1");
    expect(mockRequest.mock.calls[0][0]).toMatchObject({
      method: "POST",
      url: `/v1/messages/conversations/c1/${action}`,
    });
  });
});

describe("messages events ticket (WS auth)", () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("mints a ticket with POST /events/ticket, opting out of the interceptor refresh", async () => {
    mockRequest.mockResolvedValue({ data: { ticket: "t-1", expires_in: 30 } });
    await expect(createMessagesEventsTicket()).resolves.toEqual({ ticket: "t-1", expires_in: 30 });
    expect(mockRequest.mock.calls[0][0]).toMatchObject({
      method: "POST",
      url: "/v1/messages/events/ticket",
      _retry: true,
    });
  });

  it("rejects a 401 mint as unauthorized", async () => {
    mockRequest.mockRejectedValue(httpError(401, "invalid_token"));
    await expect(createMessagesEventsTicket()).rejects.toMatchObject({
      code: "unauthorized",
      status: 401,
    });
  });

  it("builds the socket URL from the ticket and never carries a JWT", () => {
    const url = messagesEventsUrl("https://your-api-host.example.com", "a+b/c");
    expect(url).toBe("wss://your-api-host.example.com/v1/messages/events?ticket=a%2Bb%2Fc");
    expect(url).not.toContain("token=");
  });
});

describe("upstream_rejected and invalid_cursor", () => {
  const sendBody = {
    conversation_id: "c1",
    recipient_fids: [],
    message_id: "m1",
    text: "hi",
    in_reply_to_id: null,
  };

  beforeEach(() => {
    mockRequest.mockReset();
  });

  it("maps a 422 upstream_rejected with its message and does not retry", async () => {
    mockRequest.mockRejectedValue(
      httpErrorWithData(422, { detail: "upstream_rejected", message: "  Recipient blocks DMs " }),
    );
    const failure = (await sendMessage(sendBody).catch((e: unknown) => e)) as MessagesApiError;
    expect(failure).toBeInstanceOf(MessagesApiError);
    expect(failure.code).toBe("upstream_rejected");
    expect(failure.upstreamMessage).toBe("Recipient blocks DMs");
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ detail: "upstream_rejected" }],
    [{ detail: "upstream_rejected", message: "" }],
    [{ detail: "upstream_rejected", message: 42 }],
  ])("leaves upstreamMessage null when absent or unusable (%#)", async (data) => {
    mockRequest.mockRejectedValue(httpErrorWithData(422, data));
    const failure = (await sendMessage(sendBody).catch((e: unknown) => e)) as MessagesApiError;
    expect(failure.code).toBe("upstream_rejected");
    expect(failure.upstreamMessage).toBeNull();
  });

  it("keeps a FastAPI validation 422 as unknown", async () => {
    mockRequest.mockRejectedValue(
      httpErrorWithData(422, { detail: [{ type: "missing", loc: ["body", "text"], msg: "x" }] }),
    );
    await expect(sendMessage(sendBody)).rejects.toMatchObject({ code: "unknown" });
  });

  it("maps a 400 invalid_cursor", async () => {
    mockRequest.mockRejectedValue(httpError(400, "invalid_cursor"));
    await expect(searchMessages("coffee", { cursor: "ts1.bad" })).rejects.toMatchObject({
      code: "invalid_cursor",
    });
  });
});
