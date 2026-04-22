/**
 * Safe constructors for `juke://` deeplinks.
 *
 * The backend uses UUIDs for both Room and VoiceNote primary keys
 * (see `backend/app/models/room.py` and `backend/app/models/voice_note.py`),
 * so we enforce a strict UUID shape to prevent injection of arbitrary
 * characters (e.g. query strings, path traversal) into the scheme URL.
 *
 * Returns `null` for any id that fails validation; callers should disable
 * the deeplink UI and log a warning in that case.
 */

const UUID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function isValidId(id: unknown): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

export function jukeSpaceUrl(id: string): string | null {
  if (!isValidId(id)) return null;
  return `juke://space/${encodeURIComponent(id)}`;
}

export function jukeVoiceNoteUrl(id: string): string | null {
  if (!isValidId(id)) return null;
  return `juke://voice-note/${encodeURIComponent(id)}`;
}
