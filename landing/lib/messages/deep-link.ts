/** Routes and query-string helpers for messaging deep links. */

export const MESSAGES_INBOX_PATH = "/app/messages";
export const NEW_MESSAGE_PATH = `${MESSAGES_INBOX_PATH}/new`;

/** `?fid=` as a positive integer fid, else null (missing, junk, 0, negative). */
export function parseFidParam(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const fid = Number(value.trim());
  return Number.isSafeInteger(fid) && fid > 0 ? fid : null;
}

/** Link that opens (or starts) a 1:1 with `fid`. */
export function directMessageHref(fid: number): string {
  return `${NEW_MESSAGE_PATH}?fid=${fid}`;
}

/** `/app/messages/{id}`, optionally deep-linked to `?m={messageId}`. */
export function conversationHref(conversationId: string, messageId?: string): string {
  const path = `${MESSAGES_INBOX_PATH}/${encodeURIComponent(conversationId)}`;
  return messageId ? `${path}?m=${encodeURIComponent(messageId)}` : path;
}

/**
 * Decode the `[conversationId]` route segment. A malformed escape (`%E0%A4`,
 * a lone `%`) makes `decodeURIComponent` throw a URIError; that is a
 * "conversation not found", not a crash. Empty segments are null too.
 */
export function decodeConversationParam(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.trim() ? decoded : null;
  } catch {
    return null;
  }
}
