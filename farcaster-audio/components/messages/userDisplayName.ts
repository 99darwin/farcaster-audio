import type { MessageUser } from "@/types/messages";

/** The name to show for a user: display name, else username, else `fallback`. */
export function userDisplayName(
  user: Pick<MessageUser, "display_name" | "username"> | null | undefined,
  fallback = "",
): string {
  return user?.display_name || user?.username || fallback;
}
