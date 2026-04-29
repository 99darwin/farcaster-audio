import { apiClient } from "@/services/api";

export interface GiphyGif {
  id: string;
  gifUrl: string;
  previewUrl: string;
  width: number;
  height: number;
}

export interface GiphySearchResponse {
  results: GiphyGif[];
  nextOffset: number | null;
}

interface GifResultDto {
  id: string;
  gifUrl: string;
  previewUrl: string;
  width: number;
  height: number;
}

interface GifSearchResponseDto {
  results: GifResultDto[];
  next_offset: number | null;
}

const DEFAULT_LIMIT = 24;

export async function searchGifs(
  query: string,
  offset: number = 0,
  limit: number = DEFAULT_LIMIT,
): Promise<GiphySearchResponse> {
  const trimmed = query.trim();
  const isTrending = trimmed.length === 0;

  const path = isTrending ? "/v1/gifs/trending" : "/v1/gifs/search";
  const params: Record<string, string | number> = { offset, limit };
  if (!isTrending) {
    params.q = trimmed;
  }

  const response = await apiClient.get<GifSearchResponseDto>(path, { params });
  const data = response.data;

  return {
    results: data.results ?? [],
    nextOffset: data.next_offset ?? null,
  };
}
