import { Share } from "react-native";
import * as Calendar from "expo-calendar";
import { Config } from "@/constants/config";
import { buildSpaceUrl } from "@/utils/shareLinks";
import type { Room } from "@/types/space";

const DEFAULT_SPACE_DURATION_MINUTES = 60;

export class CalendarPermissionError extends Error {
  constructor() {
    super("Calendar permission was denied");
    this.name = "CalendarPermissionError";
  }
}

export const buildSpaceCalendarUrl = (roomId: string) =>
  `${Config.WEB_BASE_URL}/space/${encodeURIComponent(roomId)}/calendar.ics`;

export const isUpcomingScheduledRoom = (room: Room) => {
  if (room.status !== "scheduled" || !room.scheduled_at) return false;
  const startsAt = new Date(room.scheduled_at);
  return Number.isFinite(startsAt.getTime()) && startsAt.getTime() > Date.now();
};

export const buildScheduledSpaceEvent = (room: Room, roomId: string) => {
  if (!room.scheduled_at) {
    throw new Error("Scheduled room is missing scheduled_at");
  }

  const startDate = new Date(room.scheduled_at);
  if (!Number.isFinite(startDate.getTime())) {
    throw new Error("Scheduled room has an invalid scheduled_at");
  }

  const endDate = new Date(
    startDate.getTime() + DEFAULT_SPACE_DURATION_MINUTES * 60 * 1000,
  );
  const joinUrl = buildSpaceUrl(roomId);
  const hostName = room.host.display_name || room.host.username;

  return {
    title: `Juke Space: ${room.title}`,
    startDate,
    endDate,
    location: joinUrl,
    url: joinUrl,
    notes: [
      `Hosted by ${hostName}`,
      "Starts on Juke",
      `Join: ${joinUrl}`,
    ].join("\n"),
    availability: Calendar.Availability.BUSY,
    alarms: [{ relativeOffset: -10 }],
  } satisfies Parameters<typeof Calendar.createEventAsync>[1];
};

export const addScheduledSpaceToNativeCalendar = async (
  room: Room,
  roomId: string,
) => {
  const permission = await Calendar.requestCalendarPermissionsAsync();
  if (permission.status !== Calendar.PermissionStatus.GRANTED) {
    throw new CalendarPermissionError();
  }

  const defaultCalendar = await Calendar.getDefaultCalendarAsync();
  if (!defaultCalendar.allowsModifications) {
    throw new Error("Default calendar does not allow event creation");
  }

  return Calendar.createEventAsync(
    defaultCalendar.id,
    buildScheduledSpaceEvent(room, roomId),
  );
};

export const shareScheduledSpaceCalendar = async (room: Room, roomId: string) =>
  Share.share({
    title: `Add "${room.title}" to your calendar`,
    message: `Add "${room.title}" to your calendar: ${buildSpaceCalendarUrl(
      roomId,
    )}`,
    url: buildSpaceCalendarUrl(roomId),
  });
