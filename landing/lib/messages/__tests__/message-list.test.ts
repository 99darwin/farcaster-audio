import {
  buildOptimisticMessage,
  compareMessages,
  countIncomingAfter,
  mergeMessages,
  mergeSendEcho,
  optimisticSentAt,
  pagesOverlap,
  removeMessage,
  toggleReaction,
  updateMessage,
} from "@/lib/messages/message-list";
import { ALICE, BASE_TIME, BOB, MINUTE, makeMessage } from "./fixtures";

describe("compareMessages", () => {
  it("orders by sent_at then message_id", () => {
    const a = makeMessage({ message_id: "b", sent_at: BASE_TIME });
    const b = makeMessage({ message_id: "a", sent_at: BASE_TIME });
    const c = makeMessage({ message_id: "z", sent_at: BASE_TIME - 1 });
    expect([a, b, c].sort(compareMessages).map((m) => m.message_id)).toEqual(["z", "a", "b"]);
  });
});

describe("mergeMessages", () => {
  const first = makeMessage({ message_id: "1", sent_at: BASE_TIME });
  const second = makeMessage({ message_id: "2", sent_at: BASE_TIME + MINUTE });

  it("returns the same reference when there is nothing to merge", () => {
    const existing = [first];
    expect(mergeMessages(existing, [])).toBe(existing);
  });

  it("dedupes and sorts pages regardless of input order", () => {
    const merged = mergeMessages([second], [second, first]);
    expect(merged.map((m) => m.message_id)).toEqual(["1", "2"]);
  });

  it("lets the server copy replace an optimistic one", () => {
    const optimistic = { ...first, send_state: "sending" as const };
    const server = { ...first, text: "server" };
    const merged = mergeMessages([optimistic], [server]);
    expect(merged).toHaveLength(1);
    expect(merged[0].send_state).toBeUndefined();
    expect(merged[0].text).toBe("server");
  });

  it("never lets an optimistic copy replace a server one", () => {
    const server = { ...first, text: "server" };
    const merged = mergeMessages([server], [{ ...first, text: "local", send_state: "sending" }]);
    expect(merged[0].text).toBe("server");
  });
});

describe("updateMessage / removeMessage", () => {
  const list = [makeMessage({ message_id: "1" }), makeMessage({ message_id: "2" })];

  it("updates only the target", () => {
    const next = updateMessage(list, "2", (m) => ({ ...m, text: "edited" }));
    expect(next[1].text).toBe("edited");
    expect(next[0]).toBe(list[0]);
  });

  it("returns the input when the id is unknown", () => {
    expect(updateMessage(list, "nope", (m) => m)).toBe(list);
    expect(removeMessage(list, "nope")).toBe(list);
  });

  it("removes the target", () => {
    expect(removeMessage(list, "1").map((m) => m.message_id)).toEqual(["2"]);
  });
});

describe("toggleReaction", () => {
  it("adds a new chip", () => {
    expect(toggleReaction([], "🔥", true)).toEqual([{ reaction: "🔥", count: 1, viewer_reacted: true }]);
  });

  it("increments and decrements existing chips", () => {
    const reactions = [{ reaction: "🔥", count: 2, viewer_reacted: false }];
    expect(toggleReaction(reactions, "🔥", true)).toEqual([{ reaction: "🔥", count: 3, viewer_reacted: true }]);
    const mine = [{ reaction: "🔥", count: 2, viewer_reacted: true }];
    expect(toggleReaction(mine, "🔥", false)).toEqual([{ reaction: "🔥", count: 1, viewer_reacted: false }]);
  });

  it("drops a chip when it reaches zero", () => {
    expect(toggleReaction([{ reaction: "🔥", count: 1, viewer_reacted: true }], "🔥", false)).toEqual([]);
  });

  it("is a no-op when the viewer state already matches", () => {
    const reactions = [{ reaction: "🔥", count: 1, viewer_reacted: true }];
    expect(toggleReaction(reactions, "🔥", true)).toBe(reactions);
    expect(toggleReaction(reactions, "❤️", false)).toBe(reactions);
  });
});

describe("buildOptimisticMessage", () => {
  it("builds a sending text message with a quote", () => {
    const quoted = makeMessage({ message_id: "q", text: "original" });
    const message = buildOptimisticMessage({
      messageId: "new",
      conversationId: "c1",
      sender: ALICE,
      text: "reply",
      sentAt: BASE_TIME,
      replyTo: quoted,
    });
    expect(message).toMatchObject({
      message_id: "new",
      sender: ALICE,
      type: "text",
      send_state: "sending",
      in_reply_to: { message_id: "q", sender: BOB, text: "original", is_deleted: false },
    });
  });
});

describe("countIncomingAfter", () => {
  const list = [
    makeMessage({ message_id: "1", sender: BOB }),
    makeMessage({ message_id: "2", sender: ALICE }),
    makeMessage({ message_id: "3", sender: BOB }),
    makeMessage({ message_id: "4", sender: BOB }),
  ];

  it("counts messages from others after the last seen id", () => {
    expect(countIncomingAfter(list, "1", ALICE.fid)).toBe(2);
  });

  it("returns 0 for unknown or missing ids", () => {
    expect(countIncomingAfter(list, null, ALICE.fid)).toBe(0);
    expect(countIncomingAfter(list, "zzz", ALICE.fid)).toBe(0);
  });
});

describe("pagesOverlap", () => {
  it("detects shared messages", () => {
    const a = [makeMessage({ message_id: "1" }), makeMessage({ message_id: "2" })];
    expect(pagesOverlap(a, [makeMessage({ message_id: "2" })])).toBe(true);
    expect(pagesOverlap(a, [makeMessage({ message_id: "3" })])).toBe(false);
    expect(pagesOverlap([], a)).toBe(false);
  });
});

describe("optimisticSentAt", () => {
  it("uses now unless the newest loaded message is later", () => {
    expect(optimisticSentAt([], BASE_TIME)).toBe(BASE_TIME);
    expect(optimisticSentAt([makeMessage({ sent_at: BASE_TIME - MINUTE })], BASE_TIME)).toBe(BASE_TIME);
    expect(optimisticSentAt([makeMessage({ sent_at: BASE_TIME + MINUTE })], BASE_TIME)).toBe(BASE_TIME + MINUTE + 1);
  });
});

describe("mergeSendEcho", () => {
  const quote = { message_id: "p", sender: BOB, text: "parent", is_deleted: false };
  it("keeps the optimistic reply quote when the echo has none", () => {
    const optimistic = makeMessage({ sender: ALICE, in_reply_to: quote, send_state: "sending" });
    const echo = makeMessage({ sender: ALICE, in_reply_to: null });
    expect(mergeSendEcho(echo, optimistic)).toEqual({ ...echo, in_reply_to: quote });
  });

  it("prefers the echo's own quote and passes through without an optimistic row", () => {
    const echoQuote = { ...quote, text: "server" };
    const echo = makeMessage({ in_reply_to: echoQuote });
    expect(mergeSendEcho(echo, makeMessage({ in_reply_to: quote }))).toBe(echo);
    expect(mergeSendEcho(echo, undefined)).toBe(echo);
  });

  it("keeps the optimistic quote over the echo's fid-0 placeholder", () => {
    const placeholder = {
      message_id: "p",
      sender: { fid: 0, username: null, display_name: "", pfp_url: null },
      text: "",
      is_deleted: false,
    };
    const optimistic = makeMessage({ sender: ALICE, in_reply_to: quote, send_state: "sending" });
    const echo = makeMessage({ sender: ALICE, in_reply_to: placeholder });
    expect(mergeSendEcho(echo, optimistic)).toEqual({ ...echo, in_reply_to: quote });
  });

  it("passes a placeholder through when there is no local quote to keep", () => {
    const placeholder = {
      message_id: "p",
      sender: { fid: 0, username: null, display_name: "", pfp_url: null },
      text: "",
      is_deleted: false,
    };
    const echo = makeMessage({ in_reply_to: placeholder });
    expect(mergeSendEcho(echo, makeMessage({ in_reply_to: null }))).toBe(echo);
  });
});
