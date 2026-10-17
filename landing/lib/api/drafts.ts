/**
 * Drafts API wrappers for the Juke web app.
 *
 * Implements CRUD for /v1/drafts following the backend contract in
 * backend/app/routers/drafts.py and the payload shapes from
 * farcaster-audio/types/draft.ts.
 *
 * Voice-note–specific fields (voice_metadata, voice-upload-url) are
 * intentionally omitted — web compose does not yet support voice drafts.
 * Publish is also omitted here; it belongs in the composer submit flow.
 *
 * All calls go through apiFetch which handles JWT attachment and 401→refresh.
 */

import { apiFetch } from "@/lib/api/client";

// ---------------------------------------------------------------------------
// Payload / response types  (mirror farcaster-audio/types/draft.ts, minus voice)
// ---------------------------------------------------------------------------

export interface DraftCastAuthor {
  fid: number;
  username: string;
  display_name: string;
  pfp_url: string | null;
}

export interface DraftCastSnapshot {
  hash: string;
  author: DraftCastAuthor;
  text: string;
}

export interface DraftQuoteCast {
  fid: number;
  hash: string;
  author?: DraftCastAuthor | null;
  text: string;
}

export type DraftMediaEmbedType = "image" | "video" | "gif" | "url";
export type DraftMediaEmbedSource = "uploaded" | "giphy" | "url";

export interface DraftMediaEmbed {
  url: string;
  type: DraftMediaEmbedType;
  source: DraftMediaEmbedSource;
  preview_url?: string | null;
}

/**
 * Fields accepted by POST /v1/drafts (create) and PATCH /v1/drafts/:id (update).
 * Voice-note fields are omitted — web scope only.
 */
export interface DraftPayload {
  text: string;
  channel_id?: string | null;
  parent_cast_hash?: string | null;
  parent_cast?: DraftCastSnapshot | null;
  quote_cast?: DraftQuoteCast | null;
  media_embeds?: DraftMediaEmbed[];
  post_to_farcaster?: boolean;
}

/** A persisted draft returned by the backend. */
export interface ComposeDraft extends DraftPayload {
  id: string;
  fid: number;
  media_embeds: DraftMediaEmbed[];
  post_to_farcaster: boolean;
  created_at: string;
  updated_at: string;
}

interface DraftListResponse {
  drafts: ComposeDraft[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** RFC 4122 UUID pattern. Used to guard path interpolation. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate that `id` is a well-formed UUID before interpolating it into a URL
 * path. Draft IDs come from the server, but defense-in-depth prevents a
 * future caller from accidentally passing a user-supplied string that contains
 * path traversal characters (e.g. `../admin`).
 *
 * @throws {Error} if `id` is not a valid UUID.
 */
function assertDraftId(id: string): void {
  if (!UUID_RE.test(id)) {
    throw new Error(`drafts: invalid draft ID format — expected UUID, got: "${id}"`);
  }
}

// ---------------------------------------------------------------------------
// CRUD wrappers
// ---------------------------------------------------------------------------

/** GET /v1/drafts — list the current user's drafts (max 50, newest first). */
export async function listDrafts(): Promise<ComposeDraft[]> {
  const data = await apiFetch<DraftListResponse | undefined>("/v1/drafts");
  return data?.drafts ?? [];
}

/** POST /v1/drafts — create a new draft. Returns 201 + the created draft. */
export async function createDraft(payload: DraftPayload): Promise<ComposeDraft> {
  return apiFetch<ComposeDraft>("/v1/drafts", {
    method: "POST",
    body: payload,
  });
}

/**
 * PATCH /v1/drafts/:id — update an existing draft (partial update — only
 * provided fields are written; omit fields you don't want to change).
 */
export async function updateDraft(
  draftId: string,
  payload: Partial<DraftPayload>,
): Promise<ComposeDraft> {
  assertDraftId(draftId);
  return apiFetch<ComposeDraft>(`/v1/drafts/${draftId}`, {
    method: "PATCH",
    body: payload,
  });
}

/** DELETE /v1/drafts/:id — permanently delete a draft. Returns void. */
export async function deleteDraft(draftId: string): Promise<void> {
  assertDraftId(draftId);
  await apiFetch<{ status: string }>(`/v1/drafts/${draftId}`, {
    method: "DELETE",
  });
}
