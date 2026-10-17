import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockGetConversationWith = jest.fn<(fid: number) => Promise<unknown>>();

jest.mock("@/services/messagesApi", () => {
  const actual = jest.requireActual("@/services/messagesApi") as Record<string, unknown>;
  return { ...actual, getConversationWith: (fid: number) => mockGetConversationWith(fid) };
});

import { MessagesApiError } from "@/services/messagesApi";
import {
  DRAFT_CONVERSATION_ROUTE,
  openDirectThread,
  openDirectThreadWithFeedback,
} from "@/components/messages/messagesNavigation";
import { useMessageStore } from "@/stores/messageStore";
import { ALICE, makeConversation } from "@/components/messages/__fixtures__/messages";

const makeRouter = () => ({ push: jest.fn(), replace: jest.fn() });
const pushedId = (router: ReturnType<typeof makeRouter>) =>
  (router.push.mock.calls[0][0] as { params: { conversationId: string } }).params.conversationId;

describe("openDirectThread", () => {
  beforeEach(() => {
    useMessageStore.getState().reset();
    mockGetConversationWith.mockReset();
  });

  it("opens a loaded conversation without a request", async () => {
    useMessageStore.getState().upsertConversation(makeConversation({ conversation_id: "known" }));
    const router = makeRouter();
    await expect(openDirectThread(router, ALICE)).resolves.toBe("opened");
    expect(pushedId(router)).toBe("known");
    expect(mockGetConversationWith).not.toHaveBeenCalled();
  });

  it("asks the server and caches the conversation it returns", async () => {
    mockGetConversationWith.mockResolvedValue(makeConversation({ conversation_id: "remote" }));
    const router = makeRouter();
    await openDirectThread(router, ALICE);
    expect(mockGetConversationWith).toHaveBeenCalledWith(ALICE.fid);
    expect(pushedId(router)).toBe("remote");
    expect(useMessageStore.getState().conversations.remote).toBeDefined();
  });

  it("opens a draft when no conversation exists", async () => {
    mockGetConversationWith.mockRejectedValue(new MessagesApiError("not_found", 404));
    const router = makeRouter();
    await openDirectThread(router, ALICE, { shouldReplace: true });
    const href = router.replace.mock.calls[0][0] as { params: Record<string, string> };
    expect(href.params.conversationId).toBe(DRAFT_CONVERSATION_ROUTE);
    expect(href.params.recipientFid).toBe(String(ALICE.fid));
    // Identity is never carried in params (deep links could forge it).
    expect(Object.keys(href.params).sort()).toEqual(["conversationId", "recipientFid"]);
  });

  it("refuses an invalid recipient without navigating", async () => {
    mockGetConversationWith.mockRejectedValue(new MessagesApiError("invalid_recipient", 400));
    const router = makeRouter();
    const onRefused = jest.fn();
    await openDirectThreadWithFeedback(router, ALICE, { onRefused });
    expect(router.push).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith("You can't message yourself.");
  });

  it("ignores a second tap while the lookup is running", async () => {
    let resolveLookup: (value: unknown) => void = () => undefined;
    mockGetConversationWith.mockReturnValue(
      new Promise((resolve) => {
        resolveLookup = resolve;
      }),
    );
    const router = makeRouter();
    const first = openDirectThread(router, ALICE);
    await expect(openDirectThread(router, ALICE)).resolves.toBe("busy");
    resolveLookup(makeConversation({ conversation_id: "remote" }));
    await first;
    expect(router.push).toHaveBeenCalledTimes(1);
  });
});
