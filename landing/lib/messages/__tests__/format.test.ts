import {
  calendarDaysBetween,
  conversationAvatar,
  conversationTitle,
  dayKey,
  formatDayLabel,
  lastMessagePreview,
  mediaLabel,
  mentionHref,
  profileHref,
  systemMessageText,
  userLabel,
} from "@/lib/messages/format";
import { ALICE, BASE_TIME, BOB, MINUTE, makeConversation, makeMessage } from "./fixtures";

const DAY = 24 * 60 * MINUTE;

describe("day helpers", () => {
  it("keys and diffs local calendar days", () => {
    expect(dayKey(BASE_TIME)).toBe("2026-10-16");
    expect(calendarDaysBetween(BASE_TIME - DAY, BASE_TIME)).toBe(1);
    expect(calendarDaysBetween(BASE_TIME, BASE_TIME + MINUTE)).toBe(0);
  });

  it("labels separators relative to now", () => {
    expect(formatDayLabel(BASE_TIME, BASE_TIME)).toBe("Today");
    expect(formatDayLabel(BASE_TIME - DAY, BASE_TIME)).toBe("Yesterday");
    expect(formatDayLabel(BASE_TIME - 400 * DAY, BASE_TIME)).toMatch(/2025/);
  });
});

describe("user + conversation labels", () => {
  it("falls back from display name to username to fid", () => {
    expect(userLabel(ALICE)).toBe("Alice");
    expect(userLabel({ ...ALICE, display_name: "" })).toBe("@alice");
    expect(userLabel({ fid: 9, username: null, display_name: "", pfp_url: null })).toBe("fid 9");
  });

  it("links profiles by username, else fid", () => {
    expect(profileHref(ALICE)).toBe("/app/profile/alice");
    expect(profileHref({ ...ALICE, username: null })).toBe("/app/profile/1");
  });

  it("path-encodes mention usernames", () => {
    expect(mentionHref("alice")).toBe("/app/profile/alice");
    expect(mentionHref("a/b?c#d")).toBe("/app/profile/a%2Fb%3Fc%23d");
    expect(mentionHref("../admin")).toBe("/app/profile/..%2Fadmin");
  });

  it("titles conversations by name, counterparty, then other participants", () => {
    expect(conversationTitle(makeConversation({ name: "Crew" }), ALICE.fid)).toBe("Crew");
    expect(conversationTitle(makeConversation(), ALICE.fid)).toBe("Bob");
    const carol = { fid: 3, username: "carol", display_name: "Carol", pfp_url: null };
    expect(
      conversationTitle(
        makeConversation({ counterparty: null, is_group: true, participants: [ALICE, BOB, carol] }),
        ALICE.fid,
      ),
    ).toBe("Bob, Carol");
  });

  it("uses the group photo, else the peer's avatar", () => {
    expect(conversationAvatar(makeConversation(), ALICE.fid)).toEqual({ src: BOB.pfp_url, name: "Bob" });
    expect(conversationAvatar(makeConversation({ photo_url: "https://x/y.png" }), ALICE.fid).src).toBe(
      "https://x/y.png",
    );
  });
});

describe("message previews", () => {
  it("describes system messages without text", () => {
    expect(systemMessageText(makeMessage({ type: "pin_message", text: "" }))).toBe("Bob pinned a message");
  });

  it("prefixes own and group messages", () => {
    expect(lastMessagePreview(null, ALICE.fid, false)).toBe("No messages yet");
    expect(lastMessagePreview(makeMessage({ sender: ALICE, text: "hi" }), ALICE.fid, false)).toBe("You: hi");
    expect(lastMessagePreview(makeMessage({ text: "hi" }), ALICE.fid, true)).toBe("Bob: hi");
    expect(lastMessagePreview(makeMessage({ text: "hi" }), ALICE.fid, false)).toBe("hi");
    expect(lastMessagePreview(makeMessage({ is_deleted: true }), ALICE.fid, false)).toBe("Message deleted");
  });

  it("labels attachment-only messages", () => {
    const media = { url: "https://x/y.png", width: 1, height: 1, mime_type: "image/png" };
    const message = makeMessage({ text: "", metadata: { medias: [media], urls: [], mentions: [], cast_hashes: [] } });
    expect(lastMessagePreview(message, ALICE.fid, false)).toBe("Photo");
  });
});

describe("media previews", () => {
  it("labels attachments by mime type", () => {
    expect(mediaLabel("image/png")).toBe("Photo");
    expect(mediaLabel("image/gif")).toBe("GIF");
    expect(mediaLabel("video/mp4")).toBe("Video");
    expect(mediaLabel("audio/mp4; codecs=mp4a")).toBe("Voice message");
    expect(mediaLabel("application/pdf")).toBe("File");
    expect(mediaLabel(null)).toBe("Photo");
  });

  it("uses the label for media-only messages and prefixes group senders", () => {
    const media = (mime_type: string | null) =>
      makeMessage({
        text: "",
        metadata: { medias: [{ url: "u", width: 1, height: 1, mime_type }], urls: [], mentions: [], cast_hashes: [] },
      });
    expect(lastMessagePreview(media("video/quicktime"), ALICE.fid, false)).toBe("Video");
    expect(lastMessagePreview(media("image/gif"), ALICE.fid, true)).toBe("Bob: GIF");
    const nameless = makeMessage({ text: "yo", sender: { fid: 77, username: "carol", display_name: "", pfp_url: null } });
    expect(lastMessagePreview(nameless, ALICE.fid, true)).toBe("@carol: yo");
  });
});
