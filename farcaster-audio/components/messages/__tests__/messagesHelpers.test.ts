import { describe, expect, it, jest } from "@jest/globals";
import { conversationTitle, previewText } from "@/components/messages/ConversationRow";
import { isConversationUnread } from "@/stores/messageStore";
import { highlightTermsFor } from "@/components/messages/SearchResultRow";
import { findSeenMessageId } from "@/components/messages/MessageList";
import { formatMatchPosition } from "@/components/messages/ThreadSearchBar";
import { splitRanges } from "@/components/messages/MessageText";
import { LENGTH_COUNTER_THRESHOLD, remainingCharacters } from "@/components/messages/Composer";
import { shouldAutoPageReactors } from "@/components/messages/ReactorsSheet";
import {
  resolveActiveHitId,
  sortHitsByTime,
  threadSearchTerms,
} from "@/components/messages/threadSearch";
import { MAX_MESSAGE_LENGTH, type MessageSearchHit } from "@/types/messages";
import {
  ALICE,
  BOB,
  makeConversation,
  makeMessage,
  VIEWER,
} from "@/components/messages/__fixtures__/messages";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("expo-image", () => ({ Image: () => null }));
jest.mock("react-native-gesture-handler/ReanimatedSwipeable", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("react-native-reanimated", () => ({ __esModule: true, default: { View: () => null } }));
jest.mock("react-native-gesture-handler", () => ({ Gesture: {}, GestureDetector: () => null }));

describe("conversation helpers", () => {
  it("titles groups by name, then members", () => {
    expect(conversationTitle(makeConversation({ is_group: true, name: "Crew" }))).toBe("Crew");
    expect(
      conversationTitle(
        makeConversation({ is_group: true, name: null, participants: [ALICE, BOB] }),
      ),
    ).toBe(`${ALICE.display_name}, ${BOB.display_name}`);
  });

  it("previews own, deleted and empty messages", () => {
    expect(previewText(makeMessage({ sender: VIEWER, text: "hi" }), VIEWER.fid)).toBe("You: hi");
    expect(previewText(makeMessage({ is_deleted: true }), VIEWER.fid)).toBe("Message deleted");
    expect(previewText(null, VIEWER.fid)).toBe("No messages yet");
  });

  it("names the sender in group previews only", () => {
    const fromAlice = makeMessage({ sender: ALICE, text: "hey" });
    expect(previewText(fromAlice, VIEWER.fid, true)).toBe(`${ALICE.display_name}: hey`);
    expect(previewText(fromAlice, VIEWER.fid, false)).toBe("hey");
    expect(previewText(makeMessage({ sender: VIEWER, text: "yo" }), VIEWER.fid, true)).toBe("You: yo");
  });

  it("labels media-only previews by mime type", () => {
    const media = (mime_type: string | null) =>
      makeMessage({
        sender: ALICE,
        text: "",
        metadata: {
          medias: [{ url: "https://x/y", width: 1, height: 1, mime_type }],
          urls: [],
          mentions: [],
          cast_hashes: [],
        },
      });
    expect(previewText(media("image/png"), VIEWER.fid)).toBe("Photo");
    expect(previewText(media("video/mp4"), VIEWER.fid)).toBe("Video");
    expect(previewText(media("application/pdf"), VIEWER.fid)).toBe("File");
    expect(previewText(media(null), VIEWER.fid)).toBe("File");
  });

  it("treats manual unread as unread", () => {
    expect(isConversationUnread(makeConversation({ unread_count: 0 }))).toBe(false);
    expect(
      isConversationUnread(makeConversation({ unread_count: 0, manually_marked_unread: true })),
    ).toBe(true);
  });
});

describe("search helpers", () => {
  const hit = (highlights: string[]) => ({
    conversation: makeConversation(),
    message: makeMessage(),
    before: [],
    after: [],
    highlights,
  });

  it("strips markup from server highlights and falls back to query words", () => {
    expect(highlightTermsFor(hit(["<em>coffee</em>"]), "x")).toEqual(["coffee"]);
    expect(highlightTermsFor(hit([]), " flat  white ")).toEqual(["flat", "white"]);
  });

  it("formats in-thread match position", () => {
    expect(formatMatchPosition(0, 0)).toBe("0 of 0");
    expect(formatMatchPosition(2, 5)).toBe("3 of 5");
  });
});

describe("findSeenMessageId", () => {
  const SENT_AT = 1_000_000;
  const own = makeMessage({ message_id: "own", sender: VIEWER, sent_at: SENT_AT });
  const pending = makeMessage({ message_id: "p", sender: VIEWER, send_state: "sending" });
  const incoming = makeMessage({ message_id: "in", sender: ALICE, sent_at: SENT_AT + 5 });

  it("marks the newest delivered own message once peer_last_read_at reaches it", () => {
    const messages = [incoming, pending, own];
    expect(findSeenMessageId(messages, VIEWER.fid, SENT_AT)).toBe("own");
    expect(findSeenMessageId(messages, VIEWER.fid, SENT_AT + 1)).toBe("own");
  });

  it("ignores the viewer's own is_last_read marker", () => {
    const viewerMarker = { ...own, is_last_read: true };
    expect(findSeenMessageId([viewerMarker], VIEWER.fid, SENT_AT - 1)).toBeNull();
  });

  it("shows nothing for never-read (0) or group / unknown (null)", () => {
    expect(findSeenMessageId([own], VIEWER.fid, 0)).toBeNull();
    expect(findSeenMessageId([own], VIEWER.fid, null)).toBeNull();
  });
});

describe("splitRanges", () => {
  it("splits on half-open UTF-16 ranges", () => {
    expect(splitRanges("flat white coffee", 0, [{ start: 5, end: 10 }])).toEqual([
      { text: "flat ", isMatch: false },
      { text: "white", isMatch: true },
      { text: " coffee", isMatch: false },
    ]);
  });

  it("maps full-text ranges into a segment at an offset", () => {
    // Segment "coffee" starts at index 11 of the full text.
    expect(splitRanges("coffee", 11, [{ start: 5, end: 10 }, { start: 11, end: 14 }])).toEqual([
      { text: "cof", isMatch: true },
      { text: "fee", isMatch: false },
    ]);
  });

  it("counts surrogate pairs as two code units", () => {
    const text = "\u{1F525} hot";
    expect(splitRanges(text, 0, [{ start: 3, end: 6 }])).toEqual([
      { text: "\u{1F525} ", isMatch: false },
      { text: "hot", isMatch: true },
    ]);
  });

  it("returns the plain text when no range touches it", () => {
    expect(splitRanges("abc", 0, [])).toEqual([{ text: "abc", isMatch: false }]);
  });
});

describe("remainingCharacters", () => {
  it("is hidden until the limit is near, then counts down past zero", () => {
    expect(remainingCharacters("hi")).toBeNull();
    const near = "x".repeat(MAX_MESSAGE_LENGTH - LENGTH_COUNTER_THRESHOLD);
    expect(remainingCharacters(near)).toBe(LENGTH_COUNTER_THRESHOLD);
    expect(remainingCharacters("x".repeat(MAX_MESSAGE_LENGTH + 3))).toBe(-3);
  });
});

describe("highlightTermsFor priority", () => {
  const base = {
    message: makeMessage(),
    conversation: makeConversation(),
    before: [],
    after: [],
  };

  it("prefers matched_terms, then fc_highlight tags, then the query", () => {
    expect(
      highlightTermsFor({ ...base, highlights: ["<fc_highlight>a</fc_highlight>"], matched_terms: ["latte"] }, "q"),
    ).toEqual(["latte"]);
    expect(
      highlightTermsFor({ ...base, highlights: ["x <fc_highlight>Latte</fc_highlight> y"] }, "q"),
    ).toEqual(["Latte"]);
    expect(highlightTermsFor({ ...base, highlights: [] }, "oat milk")).toEqual(["oat", "milk"]);
  });
});

describe("shouldAutoPageReactors", () => {
  const base = { visibleCount: 0, cursor: "next", isLoading: false, hasError: false };

  it("pages while the filtered tab is empty and more exist", () => {
    expect(shouldAutoPageReactors(base)).toBe(true);
  });

  it.each([
    { visibleCount: 1 },
    { cursor: null },
    { isLoading: true },
    { hasError: true },
  ])("stops when %p", (override) => {
    expect(shouldAutoPageReactors({ ...base, ...override })).toBe(false);
  });
});

describe("in-thread search stepping", () => {
  const hitAt = (id: string, sentAt: number, terms?: string[]): MessageSearchHit => ({
    message: makeMessage({ message_id: id, sent_at: sentAt }),
    conversation: makeConversation(),
    highlights: [],
    before: [],
    after: [],
    matched_terms: terms,
  });

  it("walks hits newest first", () => {
    const sorted = sortHitsByTime([hitAt("old", 1), hitAt("new", 3), hitAt("mid", 2)]);
    expect(sorted.map((h) => h.message.message_id)).toEqual(["new", "mid", "old"]);
  });

  it("keeps the active hit by id when a new page re-sorts the list", () => {
    const firstPage = sortHitsByTime([hitAt("b", 2), hitAt("a", 1)]);
    expect(resolveActiveHitId(null, firstPage)).toBe("b");
    const withNewer = sortHitsByTime([...firstPage, hitAt("c", 3)]);
    // An index of 0 would now point at "c"; the id keeps "b".
    expect(resolveActiveHitId("b", withNewer)).toBe("b");
    expect(resolveActiveHitId("gone", withNewer)).toBe("c");
    expect(resolveActiveHitId("b", [])).toBeNull();
  });

  it("highlights server terms before raw query words", () => {
    expect(threadSearchTerms([hitAt("a", 1, ["latte"])], "lattes")).toEqual(["latte"]);
    expect(threadSearchTerms([hitAt("a", 1)], " oat  milk ")).toEqual(["oat", "milk"]);
  });
});
