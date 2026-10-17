import { buildThreadRows, findMessageRowIndex, GROUP_WINDOW_MS, UNREAD_ROW_KEY } from "@/lib/messages/thread-rows";
import { ALICE, BASE_TIME, BOB, MINUTE, makeMessage } from "./fixtures";

const options = { viewerFid: ALICE.fid, unreadAfterId: null, now: BASE_TIME };

describe("buildThreadRows", () => {
  it("inserts one day separator per calendar day", () => {
    const yesterday = BASE_TIME - 24 * 60 * MINUTE;
    const rows = buildThreadRows(
      [
        makeMessage({ message_id: "1", sent_at: yesterday }),
        makeMessage({ message_id: "2", sent_at: BASE_TIME }),
        makeMessage({ message_id: "3", sent_at: BASE_TIME + MINUTE }),
      ],
      options,
    );
    expect(rows.map((r) => r.kind)).toEqual(["day", "message", "day", "message", "message"]);
    expect(rows[0]).toMatchObject({ label: "Yesterday" });
    expect(rows[2]).toMatchObject({ label: "Today" });
  });

  it("groups consecutive messages from one sender inside the window", () => {
    const rows = buildThreadRows(
      [
        makeMessage({ message_id: "1", sender: BOB, sent_at: BASE_TIME }),
        makeMessage({ message_id: "2", sender: BOB, sent_at: BASE_TIME + MINUTE }),
        makeMessage({ message_id: "3", sender: BOB, sent_at: BASE_TIME + MINUTE + GROUP_WINDOW_MS }),
        makeMessage({ message_id: "4", sender: ALICE, sent_at: BASE_TIME + 2 * MINUTE + GROUP_WINDOW_MS }),
      ],
      options,
    ).filter((r) => r.kind === "message");
    expect(rows.map((r) => [r.isFirstInGroup, r.isLastInGroup])).toEqual([
      [true, false],
      [false, true],
      [true, true],
      [true, true],
    ]);
    expect(rows.map((r) => r.isOwn)).toEqual([false, false, false, true]);
  });

  it("renders system messages as system rows that break groups", () => {
    const rows = buildThreadRows(
      [
        makeMessage({ message_id: "1" }),
        makeMessage({ message_id: "2", type: "group_name_change", text: "" }),
        makeMessage({ message_id: "3", sent_at: BASE_TIME + 1 }),
      ],
      options,
    );
    expect(rows.map((r) => r.kind)).toEqual(["day", "message", "system", "message"]);
    expect(rows[3]).toMatchObject({ isFirstInGroup: true });
  });

  it("places the unread divider after the anchor and splits the group", () => {
    const rows = buildThreadRows(
      [
        makeMessage({ message_id: "1", sent_at: BASE_TIME }),
        makeMessage({ message_id: "2", sent_at: BASE_TIME + 1 }),
      ],
      { ...options, unreadAfterId: "1" },
    );
    expect(rows.map((r) => r.key)).toEqual(["day:2026-10-16", "msg:1", UNREAD_ROW_KEY, "msg:2"]);
    expect(rows[1]).toMatchObject({ isLastInGroup: true });
    expect(rows[3]).toMatchObject({ isFirstInGroup: true });
  });

  it("omits the divider when only the viewer's messages follow it", () => {
    const rows = buildThreadRows(
      [makeMessage({ message_id: "1" }), makeMessage({ message_id: "2", sender: ALICE })],
      { ...options, unreadAfterId: "1" },
    );
    expect(rows.some((r) => r.key === UNREAD_ROW_KEY)).toBe(false);
  });

  it("finds message rows by id", () => {
    const rows = buildThreadRows([makeMessage({ message_id: "x" })], options);
    expect(findMessageRowIndex(rows, "x")).toBe(1);
    expect(findMessageRowIndex(rows, "y")).toBe(-1);
  });
});
