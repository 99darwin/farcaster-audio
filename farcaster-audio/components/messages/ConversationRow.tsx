/**
 * Inbox row: avatar, name, last-message preview, time and unread badge.
 * Swiping left reveals a Read / Unread toggle.
 */

import { memo, useCallback, useRef } from "react";
import { Pressable, Text, View } from "react-native";
import Swipeable, {
  type SwipeableMethods,
} from "react-native-gesture-handler/ReanimatedSwipeable";
import { Ionicons } from "@expo/vector-icons";
import { Avatar } from "@/components/common/Avatar";
import { radii, spacing, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { userDisplayName } from "@/components/messages/userDisplayName";
import { formatInboxTime } from "@/utils/messageTime";
import { haptic } from "@/utils/haptics";
import { isConversationUnread } from "@/stores/messageStore";
import { ON_ACCENT } from "@/components/messages/bubbleColors";
import type { Conversation, Message } from "@/types/messages";

const ACTION_WIDTH = 84;
const MAX_BADGE = 99;

export function conversationTitle(conversation: Conversation): string {
  if (conversation.is_group) {
    return (
      conversation.name ||
      conversation.participants
        .map((p) => userDisplayName(p))
        .filter(Boolean)
        .slice(0, 3)
        .join(", ") ||
      "Group"
    );
  }
  return userDisplayName(conversation.counterparty, "Unknown");
}

export function conversationAvatar(conversation: Conversation): string | null {
  if (conversation.is_group) return conversation.photo_url;
  return conversation.counterparty?.pfp_url ?? null;
}

/** "Photo" / "Video" / "File" label for a media-only message, by mime. */
function mediaPreviewLabel(message: Message): string {
  const media = message.metadata?.medias[0];
  if (!media) return "";
  const mime = media.mime_type?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "Photo";
  if (mime.startsWith("video/")) return "Video";
  return "File";
}

/**
 * Inbox preview line. Own messages read "You: ..."; in groups other
 * senders are named ("Alice: ...") so the line says who spoke.
 */
export function previewText(
  message: Message | null,
  viewerFid: number,
  isGroup = false,
): string {
  if (!message) return "No messages yet";
  if (message.is_deleted) return "Message deleted";
  const body = message.text.trim() || mediaPreviewLabel(message);
  if (message.sender.fid === viewerFid) return `You: ${body}`;
  if (!isGroup) return body;
  const senderName = userDisplayName(message.sender);
  return senderName ? `${senderName}: ${body}` : body;
}

interface ConversationRowProps {
  conversation: Conversation;
  viewerFid: number;
  onPress: (conversation: Conversation) => void;
  onToggleUnread: (conversation: Conversation) => void;
  /** Request rows only: both set renders Accept / Decline under the row. */
  onAccept?: (conversation: Conversation) => void;
  onDecline?: (conversation: Conversation) => void;
  /** A request response for this row is in flight. */
  isResponding?: boolean;
}

function ConversationRowImpl({
  conversation,
  viewerFid,
  onPress,
  onToggleUnread,
  onAccept,
  onDecline,
  isResponding = false,
}: ConversationRowProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const swipeableRef = useRef<SwipeableMethods | null>(null);
  const title = conversationTitle(conversation);
  const isUnread = isConversationUnread(conversation);
  const lastMessage = conversation.last_message;
  const timestamp = lastMessage?.sent_at ?? conversation.created_at;
  const badgeCount = conversation.unread_count;
  const badgeLabel = badgeCount > MAX_BADGE ? `${MAX_BADGE}+` : String(badgeCount);

  const handleAccept = useCallback(() => onAccept?.(conversation), [conversation, onAccept]);
  const handleDecline = useCallback(() => onDecline?.(conversation), [conversation, onDecline]);
  const isRequest = onAccept !== undefined && onDecline !== undefined;

  const handleToggle = useCallback(() => {
    haptic.selection();
    swipeableRef.current?.close();
    onToggleUnread(conversation);
  }, [conversation, onToggleUnread]);

  const renderRightActions = useCallback(
    () => (
      <Pressable
        onPress={handleToggle}
        style={styles.action}
        accessibilityRole="button"
        accessibilityLabel={isUnread ? "Mark as read" : "Mark as unread"}
        testID={`conversation-toggle-unread-${conversation.conversation_id}`}
      >
        <Ionicons
          name={isUnread ? "mail-open-outline" : "mail-unread-outline"}
          size={22}
          color={ON_ACCENT}
        />
        <Text style={styles.actionLabel}>{isUnread ? "Read" : "Unread"}</Text>
      </Pressable>
    ),
    [conversation.conversation_id, handleToggle, isUnread, styles],
  );

  return (
    <Swipeable
      ref={swipeableRef}
      renderRightActions={renderRightActions}
      rightThreshold={ACTION_WIDTH / 2}
      overshootRight={false}
      friction={1.6}
    >
      <Pressable
        onPress={() => onPress(conversation)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        accessibilityRole="button"
        accessibilityLabel={`${title}${isUnread ? `, ${badgeCount || ""} unread` : ""}. ${previewText(
          lastMessage,
          viewerFid,
          conversation.is_group,
        )}`}
        accessibilityActions={[
          { name: "toggleUnread", label: isUnread ? "Mark as read" : "Mark as unread" },
        ]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "toggleUnread") handleToggle();
        }}
        testID={`conversation-${conversation.conversation_id}`}
      >
        <Avatar
          pfpUrl={conversationAvatar(conversation)}
          displayName={title}
          size="md"
        />
        <View style={styles.body}>
          <View style={styles.topLine}>
            <Text
              style={[styles.title, isUnread && styles.titleUnread]}
              numberOfLines={1}
            >
              {title}
            </Text>
            {conversation.muted ? (
              <Ionicons name="volume-mute" size={14} color={colors.text.secondary} />
            ) : null}
            <Text style={[styles.time, isUnread && styles.timeUnread]}>
              {formatInboxTime(timestamp)}
            </Text>
          </View>
          <View style={styles.bottomLine}>
            <Text
              style={[styles.preview, isUnread && styles.previewUnread]}
              numberOfLines={2}
            >
              {previewText(lastMessage, viewerFid, conversation.is_group)}
            </Text>
            {isUnread ? (
              <View
                style={[
                  styles.badge,
                  conversation.muted && styles.badgeMuted,
                  badgeCount === 0 && styles.badgeDot,
                ]}
                testID={`conversation-unread-${conversation.conversation_id}`}
              >
                {badgeCount > 0 ? <Text style={styles.badgeText}>{badgeLabel}</Text> : null}
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
      {isRequest ? (
        // Siblings of the row, not children: nested pressables become
        // nested <button>s on web.
        <View style={styles.requestActions}>
          <Pressable
            onPress={handleDecline}
            disabled={isResponding}
            style={[styles.requestButton, styles.declineButton, isResponding && styles.requestButtonBusy]}
            accessibilityRole="button"
            accessibilityLabel={`Decline request from ${title}`}
            testID={`conversation-decline-${conversation.conversation_id}`}
          >
            <Text style={styles.declineLabel}>Decline</Text>
          </Pressable>
          <Pressable
            onPress={handleAccept}
            disabled={isResponding}
            style={[styles.requestButton, styles.acceptButton, isResponding && styles.requestButtonBusy]}
            accessibilityRole="button"
            accessibilityLabel={`Accept request from ${title}`}
            testID={`conversation-accept-${conversation.conversation_id}`}
          >
            <Text style={styles.acceptLabel}>Accept</Text>
          </Pressable>
        </View>
      ) : null}
    </Swipeable>
  );
}

export const ConversationRow = memo(ConversationRowImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      backgroundColor: colors.background.main,
    },
    rowPressed: { backgroundColor: colors.background.surface },
    requestActions: {
      flexDirection: "row",
      gap: spacing.sm,
      paddingLeft: spacing.lg + 48 + spacing.md,
      paddingRight: spacing.lg,
      paddingBottom: spacing.md,
      backgroundColor: colors.background.main,
    },
    requestButton: {
      flex: 1,
      minHeight: 36,
      borderRadius: radii.full,
      alignItems: "center",
      justifyContent: "center",
    },
    requestButtonBusy: { opacity: 0.5 },
    acceptButton: { backgroundColor: colors.purple },
    declineButton: { backgroundColor: colors.background.surface },
    acceptLabel: {
      color: ON_ACCENT,
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
    },
    declineLabel: {
      color: colors.text.primary,
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
    },
    body: { flex: 1, gap: 3 },
    topLine: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
    title: {
      flex: 1,
      fontSize: typography.size.lg,
      fontWeight: typography.weight.semibold,
      color: colors.text.primary,
    },
    titleUnread: { fontWeight: typography.weight.bold },
    time: {
      fontSize: typography.size.sm,
      color: colors.text.secondary,
      fontVariant: ["tabular-nums"],
    },
    timeUnread: { color: colors.purple, fontWeight: typography.weight.semibold },
    bottomLine: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
    preview: {
      flex: 1,
      fontSize: typography.size.body,
      lineHeight: 19,
      color: colors.text.secondary,
    },
    previewUnread: { color: colors.text.body },
    badge: {
      minWidth: 22,
      height: 22,
      paddingHorizontal: 6,
      borderRadius: radii.full,
      backgroundColor: colors.purple,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 1,
    },
    badgeMuted: { backgroundColor: colors.background.subtle },
    badgeDot: { minWidth: 12, width: 12, height: 12, paddingHorizontal: 0, marginTop: 4 },
    badgeText: {
      color: ON_ACCENT,
      fontSize: typography.size.sm,
      fontWeight: typography.weight.bold,
      fontVariant: ["tabular-nums"],
    },
    action: {
      width: ACTION_WIDTH,
      alignItems: "center",
      justifyContent: "center",
      gap: 2,
      backgroundColor: colors.purple,
    },
    actionLabel: {
      color: ON_ACCENT,
      fontSize: typography.size.sm,
      fontWeight: typography.weight.semibold,
    },
  }));
