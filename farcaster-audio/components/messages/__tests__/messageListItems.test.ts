import { describe, expect, it } from "@jest/globals";
import {
  buildMessageRows,
  findRowIndex,
  GROUP_GAP_MS,
  UNREAD_ROW_KEY,
} from "@/components/messages/messageListItems";
import { ALICE, BASE_TIME, BOB, makeMessage } from "@/components/messages/__fixtures__/messages";

const DAY = 24 * 60 * 60_000;

describe("buildMessageRows", () => {
  it("groups runs per sender within the gap and adds day rows above each day", () => {
    // Newest first.
    const messages = [
      makeMessage({ message_id: "4", sender: BOB, sent_at: BASE_TIME + 3_000 }),
      makeMessage({ message_id: "3", sender: ALICE, sent_at: BASE_TIME + 2_000 }),
      makeMessage({ message_id: "2", sender: ALICE, sent_at: BASE_TIME + 1_000 }),
      makeMessage({ message_id: "1", sender: ALICE, sent_at: BASE_TIME - DAY }),
    ];

    const rows = buildMessageRows(messages);

    expect(rows.map((r) => r.key)).toEqual(["4", "3", "2", "day:2", "1", "day:1"]);
    const flags = Object.fromEntries(
      rows.flatMap((r) => (r.kind === "message" ? [[r.key, [r.isRunStart, r.isRunEnd]]] : [])),
    );
    expect(flags["4"]).toEqual([true, true]);
    expect(flags["3"]).toEqual([false, true]);
    expect(flags["2"]).toEqual([true, false]);
    expect(flags["1"]).toEqual([true, true]);
  });

  it("breaks a run after the grouping gap and around system messages", () => {
    const messages = [
      makeMessage({ message_id: "c", sent_at: BASE_TIME + GROUP_GAP_MS + 1 }),
      makeMessage({ message_id: "b", sent_at: BASE_TIME, type: "pin_message" }),
      makeMessage({ message_id: "a", sent_at: BASE_TIME - 1 }),
    ];
    const rows = buildMessageRows(messages).filter((r) => r.kind === "message");
    for (const row of rows) {
      if (row.kind !== "message") continue;
      expect([row.isRunStart, row.isRunEnd]).toEqual([true, true]);
    }
  });

  it("finds message rows by id", () => {
    const rows = buildMessageRows([makeMessage({ message_id: "x" })]);
    expect(findRowIndex(rows, "x")).toBe(0);
    expect(findRowIndex(rows, "missing")).toBe(-1);
  });
});

describe("buildMessageRows unread separator", () => {
  const messages = [
    makeMessage({ message_id: "3", sender: ALICE, sent_at: BASE_TIME + 2_000 }),
    makeMessage({ message_id: "2", sender: ALICE, sent_at: BASE_TIME + 1_000 }),
    makeMessage({ message_id: "1", sender: ALICE, sent_at: BASE_TIME }),
  ];

  it("places the separator directly above the oldest unread message", () => {
    const rows = buildMessageRows(messages, "2");
    // Inverted list: a later index renders higher on screen.
    expect(rows.map((r) => r.key)).toEqual(["3", "2", UNREAD_ROW_KEY, "1", "day:1"]);
  });

  it("breaks the sender run at the separator", () => {
    const rows = buildMessageRows(messages, "2");
    const flags = Object.fromEntries(
      rows.flatMap((r) => (r.kind === "message" ? [[r.key, [r.isRunStart, r.isRunEnd]]] : [])),
    );
    expect(flags["2"]).toEqual([true, false]);
    expect(flags["1"]).toEqual([true, true]);
  });

  it("sits below the day header when the unread message opens a day", () => {
    const rows = buildMessageRows(messages, "1");
    expect(rows.map((r) => r.key).slice(-3)).toEqual(["1", UNREAD_ROW_KEY, "day:1"]);
  });

  it("adds nothing without a separator id", () => {
    expect(buildMessageRows(messages).some((r) => r.kind === "unread")).toBe(false);
  });
});
