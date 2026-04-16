import axios from "axios";
import { Config } from "@/constants/config";
import { getTokens } from "@/services/storage";
import type {
  NeynarCastWithReplies,
  NeynarFeedResponse,
} from "@/types/neynar";

const neynarClient = axios.create({
  baseURL: Config.API_BASE_URL,
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
  },
});

// Request interceptor: attach JWT
neynarClient.interceptors.request.use(async (config) => {
  const tokens = await getTokens();
  if (tokens?.jwt) {
    config.headers.Authorization = `Bearer ${tokens.jwt}`;
  }
  return config;
});

neynarClient.interceptors.response.use(
  (r) => r,
  (err) => {
    if (__DEV__) {
      console.error(
        `[Neynar] ${err.config?.method?.toUpperCase()} ${err.config?.url} → ${err.response?.status}`,
        err.response?.data,
      );
    }
    return Promise.reject(err);
  },
);

export async function fetchFollowingFeed(
  limit: number = 25,
  cursor?: string,
): Promise<NeynarFeedResponse> {
  const params: Record<string, string | number> = { limit };
  if (cursor) params.cursor = cursor;
  const { data } = await neynarClient.get<NeynarFeedResponse>(
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
  const { data } = await neynarClient.post("/v1/feed/cast", payload);
  return data?.cast ?? data;
}

export async function deleteCast(castHash: string): Promise<void> {
  await neynarClient.delete(`/v1/feed/cast/${castHash}`);
}

// --- Reactions (signer_uuid injected server-side) ---

export async function likeCast(castHash: string): Promise<void> {
  await neynarClient.post("/v1/feed/reaction", {
    reaction_type: "like",
    target: castHash,
  });
}

export async function recastCast(castHash: string): Promise<void> {
  await neynarClient.post("/v1/feed/reaction", {
    reaction_type: "recast",
    target: castHash,
  });
}

export async function removeLike(castHash: string): Promise<void> {
  await neynarClient.delete("/v1/feed/reaction", {
    data: {
      reaction_type: "like",
      target: castHash,
    },
  });
}

export async function removeRecast(castHash: string): Promise<void> {
  await neynarClient.delete("/v1/feed/reaction", {
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
): Promise<{ conversation: { cast: NeynarCastWithReplies } }> {
  const params: Record<string, string | number> = {
    hash: castHash,
    reply_depth: replyDepth,
  };
  const { data } = await neynarClient.get("/v1/feed/cast/thread", { params });
  return data;
}
