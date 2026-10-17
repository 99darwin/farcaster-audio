/**
 * Unauthenticated FID / username lookup against the public Hypersnap node,
 * used by the sign-in screen before the user has a Juke session.
 *
 * Uses its own axios instance on purpose: the shared `apiClient` attaches the
 * Juke JWT, which must never be sent to a third-party node.
 */

import axios from "axios";
import { Config } from "@/constants/config";

const LOOKUP_TIMEOUT_MS = 10_000;
const HTTP_NOT_FOUND = 404;
const FID_PATTERN = /^\d{1,12}$/;
/** fname (≤16 chars, lowercase alnum + hyphen) or an ENS-style `.eth` name. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,15}(\.eth)?$/;

const hypersnapClient = axios.create({
  baseURL: Config.HYPERSNAP_HTTP_URL,
  timeout: LOOKUP_TIMEOUT_MS,
});

export interface FarcasterUserSummary {
  fid: number;
  username: string;
  displayName: string | null;
  pfpUrl: string | null;
  custodyAddress: string | null;
}

export class FarcasterLookupError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_query" | "not_found" | "unavailable",
  ) {
    super(message);
    this.name = "FarcasterLookupError";
  }
}

interface HypersnapUser {
  fid: number;
  username?: string | null;
  display_name?: string | null;
  pfp_url?: string | null;
  custody_address?: string | null;
}

function toSummary(user: HypersnapUser): FarcasterUserSummary {
  return {
    fid: user.fid,
    username: user.username ?? `!${user.fid}`,
    displayName: user.display_name ?? null,
    pfpUrl: user.pfp_url ?? null,
    custodyAddress: user.custody_address || null,
  };
}

export type LookupQuery =
  { kind: "fid"; fid: number } | { kind: "username"; username: string };

/** Parse what the user typed: a numeric FID, or a username with optional @. */
export function parseLookupQuery(raw: string): LookupQuery | null {
  const trimmed = raw.trim();
  if (FID_PATTERN.test(trimmed)) {
    const fid = Number(trimmed);
    return fid > 0 ? { kind: "fid", fid } : null;
  }
  const username = trimmed.replace(/^@/, "").toLowerCase();
  return USERNAME_PATTERN.test(username)
    ? { kind: "username", username }
    : null;
}

async function fetchUser(query: LookupQuery): Promise<HypersnapUser | null> {
  if (query.kind === "fid") {
    const { data } = await hypersnapClient.get<{ users?: HypersnapUser[] }>(
      "/v2/farcaster/user/bulk",
      { params: { fids: String(query.fid) } },
    );
    return data.users?.find((u) => u.fid === query.fid) ?? null;
  }
  const { data } = await hypersnapClient.get<{ user?: HypersnapUser }>(
    "/v2/farcaster/user/by-username",
    { params: { username: query.username } },
  );
  return data.user ?? null;
}

/** Resolve a typed FID or username to a Farcaster account. */
export async function lookupFarcasterUser(
  raw: string,
): Promise<FarcasterUserSummary> {
  const query = parseLookupQuery(raw);
  if (!query) {
    throw new FarcasterLookupError(
      "Enter your Farcaster username or FID.",
      "invalid_query",
    );
  }
  let user: HypersnapUser | null;
  try {
    user = await fetchUser(query);
  } catch (error) {
    if (
      axios.isAxiosError(error) &&
      error.response?.status === HTTP_NOT_FOUND
    ) {
      user = null;
    } else {
      throw new FarcasterLookupError(
        "Couldn't reach the Farcaster network. Try again.",
        "unavailable",
      );
    }
  }
  // `user/bulk` answers unknown FIDs with a placeholder whose custody
  // address is empty (verified live), so that is the "not registered" signal.
  if (
    !user ||
    !Number.isSafeInteger(user.fid) ||
    user.fid <= 0 ||
    !user.custody_address
  ) {
    throw new FarcasterLookupError(
      "No Farcaster account found for that username or FID.",
      "not_found",
    );
  }
  return toSummary(user);
}
