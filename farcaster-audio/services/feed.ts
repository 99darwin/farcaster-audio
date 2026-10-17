import axios from "axios";
import { Config } from "@/constants/config";
import { getTokens } from "@/services/storage";
import type {
  FarcasterCast,
  FarcasterCastWithReplies,
  FarcasterFeedResponse,
} from "@/types/farcaster";

/**
 * Client for the Juke backend's `/v1/feed/*` routes (feed, casting,
 * reactions, threads). All Farcaster reads and writes go through the backend,
 * which resolves the viewer from the JWT and owns the upstream data source
 * and signer. The app never calls a Farcaster data provider directly and
 * ships no provider API keys.
 */
const feedClient = axios.create({
  baseURL: Config.API_BASE_URL,
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
  },
});

// Request interceptor: attach JWT
feedClient.interceptors.request.use(async (config) => {
  const tokens = await getTokens();
  if (tokens?.jwt) {
    config.headers.Authorization = `Bearer ${tokens.jwt}`;
  }
  return config;
});

feedClient.interceptors.response.use(
  (r) => r,
  (err) => {
    if (__DEV__) {
      console.error(
        `[Feed] ${err.config?.method?.toUpperCase()} ${err.config?.url} → ${err.response?.status}`,
        err.response?.data,
      );
    }
    return Promise.reject(err);
  },
);

export async function fetchFollowingFeed(
  limit: number = 25,
  cursor?: string,
): Promise<FarcasterFeedResponse> {
  const params: Record<string, string | number> = { limit };
  if (cursor) params.cursor = cursor;
  const { data } = await feedClient.get<FarcasterFeedResponse>(
    "/v1/feed/following",
    { params },
  );
  return data;
}

// --- Casting ---

export async function publishCast(
  text: string,
  parent?: string,
  embeds?: string[],
  quote?: { fid: number; hash: string },
): Promise<{ hash: string }> {
  const payload: Record<string, unknown> = { text };
  if (parent) payload.parent = parent;
  if (embeds && embeds.length > 0) payload.embeds = embeds;
  if (quote) payload.quote = quote;
  const { data } = await feedClient.post("/v1/feed/cast", payload);
  return data?.cast ?? data;
}

/** One cast segment in a thread publish request. */
export interface ThreadCastSegment {
  text: string;
  embeds?: string[];
  /** Only valid on the first segment. */
  quote?: { fid: number; hash: string };
}

export interface ThreadPublishedCast {
  index: number;
  hash: string;
}

/**
 * Response from POST /v1/feed/cast/thread.
 * 201 → success: true, all casts published.
 * 207 → success: false, `casts` holds the published prefix and
 * `failed_index` points at the first segment that failed.
 * Root-cast failure surfaces as a 502 (axios throws).
 */
export interface ThreadPublishResponse {
  success: boolean;
  casts: ThreadPublishedCast[];
  failed_index: number | null;
  error: string | null;
}

export async function publishCastThread(params: {
  casts: ThreadCastSegment[];
  /** Reply-thread parent cast hash. Mutually exclusive with channelId. */
  parent?: string;
  /** Channel for a root thread. Mutually exclusive with parent. */
  channelId?: string;
}): Promise<ThreadPublishResponse> {
  const payload: Record<string, unknown> = { casts: params.casts };
  if (params.parent) payload.parent = params.parent;
  if (!params.parent && params.channelId) {
    payload.channel_id = params.channelId;
  }
  // 207 (partial success) is within axios' default 2xx acceptance, so both
  // full and partial results resolve here; root failure (502) throws.
  const { data } = await feedClient.post<ThreadPublishResponse>(
    "/v1/feed/cast/thread",
    payload,
  );
  return data;
}

export async function deleteCast(castHash: string): Promise<void> {
  await feedClient.delete(`/v1/feed/cast/${castHash}`);
}

// --- Reactions (the backend signs with the user's signer) ---

export async function likeCast(castHash: string): Promise<void> {
  await feedClient.post("/v1/feed/reaction", {
    reaction_type: "like",
    target: castHash,
  });
}

export async function recastCast(castHash: string): Promise<void> {
  await feedClient.post("/v1/feed/reaction", {
    reaction_type: "recast",
    target: castHash,
  });
}

export async function removeLike(castHash: string): Promise<void> {
  await feedClient.delete("/v1/feed/reaction", {
    data: {
      reaction_type: "like",
      target: castHash,
    },
  });
}

export async function removeRecast(castHash: string): Promise<void> {
  await feedClient.delete("/v1/feed/reaction", {
    data: {
      reaction_type: "recast",
      target: castHash,
    },
  });
}

// --- Thread ---

export async function fetchCastThread(
  castHash: string,
  _viewerFid?: number,
  replyDepth: number = 5,
): Promise<{
  conversation: {
    cast: FarcasterCastWithReplies;
    /** Parent chain above `cast`, oldest first (capped server-side). */
    chronological_parent_casts?: FarcasterCast[];
  };
}> {
  const params: Record<string, string | number> = {
    hash: castHash,
    reply_depth: replyDepth,
  };
  const { data } = await feedClient.get("/v1/feed/cast/thread", { params });
  return data;
}
