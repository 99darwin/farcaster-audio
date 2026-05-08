import { describe, expect, it, jest } from "@jest/globals";

jest.mock("expo-calendar", () => ({
  Availability: { BUSY: "busy" },
  PermissionStatus: { GRANTED: "granted" },
  requestCalendarPermissionsAsync: jest.fn(),
  getDefaultCalendarAsync: jest.fn(),
  createEventAsync: jest.fn(),
}));

import {
  buildGoogleCalendarUrl,
  buildScheduledSpaceEvent,
  buildSpaceCalendarUrl,
  isUpcomingScheduledRoom,
} from "../calendar";
import type { Room } from "@/types/space";

const buildRoom = (scheduledAt: string): Room => ({
  id: "room-1",
  title: "Builders Hour",
  host_fid: 123,
  host: {
    fid: 123,
    username: "alice",
    display_name: "Alice",
    pfp_url: null,
    custody_address: "0x0",
    is_pro: false,
    is_admin: false,
  },
  status: "scheduled",
  started_at: scheduledAt,
  ended_at: null,
  scheduled_at: scheduledAt,
  speaker_count: 0,
  listener_count: 0,
  recording: false,
  cast_hash: null,
});

describe("calendar service", () => {
  it("builds the stable ICS URL from the room id", () => {
    expect(buildSpaceCalendarUrl("room 1")).toBe(
      "https://juke.audio/space/room%201/calendar.ics",
    );
  });

  it("treats scheduled future rooms as calendar-eligible", () => {
    const room = buildRoom(new Date(Date.now() + 60_000).toISOString());

    expect(isUpcomingScheduledRoom(room)).toBe(true);
  });

  it("does not expose calendar action for past scheduled rooms", () => {
    const room = buildRoom(new Date(Date.now() - 60_000).toISOString());

    expect(isUpcomingScheduledRoom(room)).toBe(false);
  });

  it("builds a one-hour native calendar event from room data", () => {
    const startsAt = "2026-06-01T18:00:00.000Z";
    const event = buildScheduledSpaceEvent(buildRoom(startsAt), "room-1");

    expect(event).toMatchObject({
      title: "Juke Space: Builders Hour",
      location: "https://juke.audio/space/room-1",
      url: "https://juke.audio/space/room-1",
      availability: "busy",
    });
    expect(event.notes).toContain("Hosted by Alice");
    expect(event.notes).toContain("Starts on Juke");
    expect(event.startDate).toEqual(new Date(startsAt));
    expect(event.endDate).toEqual(new Date("2026-06-01T19:00:00.000Z"));
  });

  it("builds a Google Calendar URL from room data", () => {
    const url = new URL(
      buildGoogleCalendarUrl(buildRoom("2026-06-01T18:00:00.000Z"), "room-1"),
    );

    expect(url.origin + url.pathname).toBe(
      "https://calendar.google.com/calendar/render",
    );
    expect(url.searchParams.get("action")).toBe("TEMPLATE");
    expect(url.searchParams.get("text")).toBe("Juke Space: Builders Hour");
    expect(url.searchParams.get("dates")).toBe(
      "20260601T180000Z/20260601T190000Z",
    );
    expect(url.searchParams.get("details")).toContain("Hosted by Alice");
    expect(url.searchParams.get("location")).toBe(
      "https://juke.audio/space/room-1",
    );
  });
});
