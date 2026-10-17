import { Config } from "@/constants/config";

export const buildSpaceUrl = (roomId: string) =>
  `${Config.WEB_BASE_URL}/space/${roomId}`;

// Durable, shareable link to a finalized recording's hosted web player
// (`juke.audio/r/{roomId}`). That page re-presigns a fresh S3 URL on every
// server render, so this link never expires — unlike `recording_url`, which
// is a short-lived (~15 min) presigned URL that must never be shared
// directly (doing so produces "Request has expired" once the TTL lapses).
export const buildRecordingUrl = (roomId: string) =>
  `${Config.WEB_BASE_URL}/r/${roomId}`;

export const buildAppUrl = () => Config.WEB_BASE_URL;
