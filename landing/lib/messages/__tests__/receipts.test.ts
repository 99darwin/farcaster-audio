import { isSeenByPeer, placeReadReceipt } from "@/lib/messages/receipts";
import { ALICE, BASE_TIME, MINUTE, makeMessage } from "./fixtures";

describe("isSeenByPeer", () => {
  it("is seen iff peer_last_read_at >= sent_at", () => {
    expect(isSeenByPeer(BASE_TIME, BASE_TIME)).toBe(true);
    expect(isSeenByPeer(BASE_TIME, BASE_TIME + 1)).toBe(true);
    expect(isSeenByPeer(BASE_TIME, BASE_TIME - 1)).toBe(false);
  });

  it("is never seen for 0 (never read) or null/undefined (group/unknown)", () => {
    expect(isSeenByPeer(0, 0)).toBe(false);
    expect(isSeenByPeer(BASE_TIME, null)).toBe(false);
    expect(isSeenByPeer(BASE_TIME, undefined)).toBe(false);
  });
});

describe("placeReadReceipt", () => {
  const own = (id: string, at: number, extra = {}) =>
    makeMessage({ message_id: id, sender: ALICE, sent_at: at, ...extra });

  it("labels the newest confirmed own message", () => {
    const messages = [own("a", BASE_TIME), own("b", BASE_TIME + MINUTE)];
    expect(placeReadReceipt(messages, ALICE.fid, BASE_TIME)).toEqual({ messageId: "b", receipt: "sent" });
    expect(placeReadReceipt(messages, ALICE.fid, BASE_TIME + MINUTE)).toEqual({ messageId: "b", receipt: "seen" });
  });

  it("skips optimistic and deleted rows", () => {
    const messages = [
      own("a", BASE_TIME),
      own("gone", BASE_TIME + 1, { is_deleted: true }),
      own("pending", BASE_TIME + 2, { send_state: "sending" }),
    ];
    expect(placeReadReceipt(messages, ALICE.fid, BASE_TIME)).toEqual({ messageId: "a", receipt: "seen" });
  });

  it("shows nothing after a reply, for groups, or without a viewer", () => {
    const messages = [own("a", BASE_TIME), makeMessage({ message_id: "r", sent_at: BASE_TIME + 1 })];
    expect(placeReadReceipt(messages, ALICE.fid, BASE_TIME + 1)).toBeNull();
    expect(placeReadReceipt([own("a", BASE_TIME)], ALICE.fid, null)).toBeNull();
    expect(placeReadReceipt([own("a", BASE_TIME)], ALICE.fid, undefined)).toBeNull();
    expect(placeReadReceipt([own("a", BASE_TIME)], null, BASE_TIME)).toBeNull();
    expect(placeReadReceipt([], ALICE.fid, BASE_TIME)).toBeNull();
  });
});
