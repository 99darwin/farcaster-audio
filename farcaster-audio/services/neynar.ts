import axios from 'axios';
import { Config } from '@/constants/config';
import { getTokens } from '@/services/storage';
import type { NeynarFeedResponse } from '@/types/neynar';

const neynarClient = axios.create({
  baseURL: Config.API_BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
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
    console.error(`[Neynar] ${err.config?.method?.toUpperCase()} ${err.config?.url} → ${err.response?.status}`, err.response?.data);
    return Promise.reject(err);
  },
);

export async function fetchFollowingFeed(
  fid: number,
  limit: number = 25,
  cursor?: string,
): Promise<NeynarFeedResponse> {
  const params: Record<string, string | number> = { fid, limit };
  if (cursor) params.cursor = cursor;
  const { data } = await neynarClient.get<NeynarFeedResponse>('/v1/feed/following', { params });
  return data;
}

export async function likeCast(signerUuid: string, castHash: string): Promise<void> {
  await neynarClient.post('/v1/feed/reaction', {
    signer_uuid: signerUuid,
    reaction_type: 'like',
    target: castHash,
  });
}

export async function recastCast(signerUuid: string, castHash: string): Promise<void> {
  await neynarClient.post('/v1/feed/reaction', {
    signer_uuid: signerUuid,
    reaction_type: 'recast',
    target: castHash,
  });
}

export async function removeLike(signerUuid: string, castHash: string): Promise<void> {
  await neynarClient.delete('/v1/feed/reaction', {
    data: {
      signer_uuid: signerUuid,
      reaction_type: 'like',
      target: castHash,
    },
  });
}

export async function removeRecast(signerUuid: string, castHash: string): Promise<void> {
  await neynarClient.delete('/v1/feed/reaction', {
    data: {
      signer_uuid: signerUuid,
      reaction_type: 'recast',
      target: castHash,
    },
  });
}
