/**
 * One message bubble: quote, text, embeds, time + delivery state, tail on
 * the newest bubble of a run, reaction chips, and a flash when jumped to.
 *
 * Interaction (gestures other than swipe live here so the bubble owns its
 * hit area): long-press opens the reaction/context overlay anchored to the
 * bubble's window rect, double-tap sends the quick reaction, tapping a
 * failed bubble retries it.
 */

import { memo, useCallback, useEffect, useRef } from "react";
import {
  Animated,
  Pressable,
  Text,
  View,
  type AccessibilityActionEvent,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Avatar } from "@/components/common/Avatar";
import { MessageText } from "@/components/messages/MessageText";
import { QuotedMessage } from "@/components/messages/QuotedMessage";
import { MessageEmbeds } from "@/components/messages/MessageEmbeds";
import { ReactionChips } from "@/components/messages/ReactionChips";
import { getBubbleColors, ON_ACCENT } from "@/components/messages/bubbleColors";
import { radii, spacing, typography, withAlpha } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { userDisplayName } from "@/components/messages/userDisplayName";
import { formatBubbleTime } from "@/utils/messageTime";
import { haptic } from "@/utils/haptics";
import type { HighlightRange, Message } from "@/types/messages";

const DOUBLE_TAP_WINDOW_MS = 280;
const LONG_PRESS_DELAY_MS = 320;
const HIGHLIGHT_FADE_IN_MS = 140;
const HIGHLIGHT_FADE_OUT_MS = 420;
/** Jump-target pulse: in, dip, back in (Telegram-style double beat). */
const HIGHLIGHT_PULSE_MS = 180;
const HIGHLIGHT_PULSE_DIP = 0.35;
const TAIL_SIZE = 10;

export interface BubbleRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MessageBubbleProps {
  message: Message;
  isOwn: boolean;
  isGroup: boolean;
  isRunStart: boolean;
  isRunEnd: boolean;
  isHighlighted: boolean;
  /** Show the "Seen" receipt under this (own, newest) bubble. */
  isSeen: boolean;
  highlightTerms?: string[];
  /** Exact search-hit ranges into `message.text`; win over terms. */
  highlightRanges?: readonly HighlightRange[];
  onLongPress: (message: Message, rect: BubbleRect) => void;
  onDoubleTap: (message: Message) => void;
  onQuotePress: (messageId: string) => void;
  onReactionChipPress: (message: Message, reaction: string) => void;
  onRetry: (message: Message) => void;
  onReply: (message: Message) => void;
  onSenderPress: (fid: number) => void;
  onMentionPress: (username: string, message: Message) => void;
}

const SYSTEM_FALLBACK: Record<Message["type"], string> = {
  text: "",
  group_name_change: "Group name changed",
  group_membership_addition: "Someone joined the group",
  group_membership_removal: "Someone left the group",
  pin_message: "A message was pinned",
  message_ttl_change: "Disappearing messages setting changed",
  rich_announcement: "Announcement",
};

function SystemMessage({ message }: { message: Message }) {
  const styles = useStyles();
  return (
    <View style={styles.systemRow} accessibilityRole="text">
      <Text style={styles.systemText}>
        {message.text.trim() || SYSTEM_FALLBACK[message.type]}
      </Text>
    </View>
  );
}

function MessageBubbleImpl(props: MessageBubbleProps) {
  const {
    message,
    isOwn,
    isGroup,
    isRunStart,
    isRunEnd,
    isHighlighted,
    isSeen,
    highlightTerms,
    highlightRanges,
    onLongPress,
    onDoubleTap,
    onQuotePress,
    onReactionChipPress,
    onRetry,
    onReply,
    onSenderPress,
    onMentionPress,
  } = props;
  const { colors, scheme } = useTheme();
  const styles = useStyles();
  const palette = getBubbleColors(colors, scheme);
  const bubbleRef = useRef<View>(null);
  const lastTapAtRef = useRef(0);
  const flash = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!isHighlighted) {
      Animated.timing(flash, {
        toValue: 0,
        duration: HIGHLIGHT_FADE_OUT_MS,
        useNativeDriver: true,
      }).start();
      return;
    }
    const to = (toValue: number, duration: number) =>
      Animated.timing(flash, { toValue, duration, useNativeDriver: true });
    Animated.sequence([
      to(1, HIGHLIGHT_FADE_IN_MS),
      to(HIGHLIGHT_PULSE_DIP, HIGHLIGHT_PULSE_MS),
      to(1, HIGHLIGHT_PULSE_MS),
    ]).start();
  }, [flash, isHighlighted]);

  const handleMentionPress = useCallback(
    (username: string) => onMentionPress(username, message),
    [message, onMentionPress],
  );

  const isFailed = message.send_state === "failed";
  const isSending = message.send_state === "sending";
  const isInteractive = !message.is_deleted && !message.send_state;

  const handleLongPress = useCallback(() => {
    if (!isInteractive) return;
    haptic.medium();
    const node = bubbleRef.current;
    if (typeof node?.measureInWindow !== "function") {
      onLongPress(message, { x: 0, y: 0, width: 0, height: 0 });
      return;
    }
    node.measureInWindow((x, y, width, height) =>
      onLongPress(message, { x, y, width, height }),
    );
  }, [isInteractive, message, onLongPress]);

  const handlePress = useCallback(() => {
    if (isFailed) {
      onRetry(message);
      return;
    }
    if (!isInteractive) return;
    const now = Date.now();
    if (now - lastTapAtRef.current <= DOUBLE_TAP_WINDOW_MS) {
      lastTapAtRef.current = 0;
      onDoubleTap(message);
      return;
    }
    lastTapAtRef.current = now;
  }, [isFailed, isInteractive, message, onDoubleTap, onRetry]);

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const action = event.nativeEvent.actionName;
      if (action === "reply") onReply(message);
      if (action === "longpress") handleLongPress();
      if (action === "activate" && isFailed) onRetry(message);
    },
    [handleLongPress, isFailed, message, onReply, onRetry],
  );

  if (message.type !== "text") return <SystemMessage message={message} />;

  const senderName = userDisplayName(message.sender, "Unknown");
  const showSenderName = isGroup && !isOwn && isRunStart;
  const showAvatarColumn = isGroup && !isOwn;
  const textColor = isOwn ? palette.ownText : palette.otherText;
  const metaColor = isOwn ? palette.ownMeta : palette.otherMeta;
  const bubbleBackground = isOwn ? palette.ownBackground : palette.otherBackground;
  const time = formatBubbleTime(message.sent_at);

  return (
    <View
      style={[
        styles.row,
        isOwn ? styles.rowOwn : styles.rowOther,
        isRunStart ? styles.rowRunStart : styles.rowRunContinued,
      ]}
      testID={`message-${message.message_id}`}
    >
      {showAvatarColumn ? (
        <View style={styles.avatarColumn}>
          {isRunEnd ? (
            <Pressable
              onPress={() => onSenderPress(message.sender.fid)}
              accessibilityLabel={`Open ${senderName}'s profile`}
            >
              <Avatar
                pfpUrl={message.sender.pfp_url}
                displayName={senderName}
                size="sm"
              />
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <View style={[styles.column, isOwn ? styles.columnOwn : styles.columnOther]}>
        <Pressable
          ref={bubbleRef}
          onPress={handlePress}
          onLongPress={handleLongPress}
          delayLongPress={LONG_PRESS_DELAY_MS}
          style={[
            styles.bubble,
            { backgroundColor: bubbleBackground },
            isOwn ? styles.bubbleOwn : styles.bubbleOther,
            isRunEnd && (isOwn ? styles.bubbleOwnTail : styles.bubbleOtherTail),
            isSending && styles.bubbleSending,
            isFailed && styles.bubbleFailed,
          ]}
          accessibilityLabel={`${isOwn ? "You" : senderName}: ${
            message.is_deleted ? "Message deleted" : message.text
          }, ${time}${isFailed ? ", not delivered, tap to retry" : ""}`}
          accessibilityHint={isInteractive ? "Long press for reactions and actions" : undefined}
          accessibilityActions={
            isInteractive
              ? [
                  { name: "reply", label: "Reply" },
                  { name: "longpress", label: "React or more actions" },
                ]
              : isFailed
                ? [{ name: "activate", label: "Retry" }]
                : undefined
          }
          onAccessibilityAction={handleAccessibilityAction}
          testID={`bubble-${message.message_id}`}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              styles.flash,
              { opacity: flash, backgroundColor: withAlpha(colors.warning, 0.35) },
            ]}
          />
          {showSenderName ? (
            <Text style={styles.senderName} numberOfLines={1}>
              {senderName}
            </Text>
          ) : null}
          {message.in_reply_to && !message.is_deleted ? (
            <QuotedMessage
              quote={message.in_reply_to}
              isOnAccent={isOwn}
              onPress={() => onQuotePress(message.in_reply_to!.message_id)}
            />
          ) : null}
          {message.is_deleted ? (
            <Text style={[styles.text, styles.deleted, { color: metaColor }]}>
              Message deleted
            </Text>
          ) : (
            <MessageText
              text={message.text}
              style={[styles.text, { color: textColor }]}
              linkColor={isOwn ? ON_ACCENT : colors.purple}
              highlightTerms={highlightTerms}
              highlightRanges={highlightRanges}
              onMentionPress={handleMentionPress}
            />
          )}
          {!message.is_deleted ? <MessageEmbeds metadata={message.metadata} /> : null}
          <View style={styles.meta}>
            <Text style={[styles.time, { color: metaColor }]}>{time}</Text>
            {isOwn && isSending ? (
              <Ionicons name="time-outline" size={12} color={metaColor} />
            ) : null}
            {isOwn && isFailed ? (
              <Ionicons name="alert-circle" size={13} color={ON_ACCENT} />
            ) : null}
          </View>
          {isRunEnd ? (
            <View
              pointerEvents="none"
              style={[
                styles.tail,
                isOwn ? styles.tailOwn : styles.tailOther,
                { backgroundColor: bubbleBackground },
              ]}
            />
          ) : null}
        </Pressable>

        {isFailed ? (
          <Pressable onPress={() => onRetry(message)} hitSlop={6}>
            <Text style={styles.failedText}>Not delivered · Tap to retry</Text>
          </Pressable>
        ) : null}

        <ReactionChips
          reactions={message.reactions}
          isOwn={isOwn}
          onChipPress={(reaction) => onReactionChipPress(message, reaction)}
        />

        {isSeen ? <Text style={styles.seen}>Seen</Text> : null}
      </View>
    </View>
  );
}

export const MessageBubble = memo(MessageBubbleImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      flexDirection: "row",
      alignItems: "flex-end",
      paddingHorizontal: spacing.md,
    },
    rowOwn: { justifyContent: "flex-end" },
    rowOther: { justifyContent: "flex-start" },
    rowRunStart: { marginTop: spacing.sm },
    rowRunContinued: { marginTop: 2 },
    avatarColumn: { width: 32, marginRight: spacing.xs + 2 },
    column: { maxWidth: "80%" },
    columnOwn: { alignItems: "flex-end" },
    columnOther: { alignItems: "flex-start" },
    bubble: {
      paddingHorizontal: spacing.md,
      paddingTop: 7,
      paddingBottom: 6,
      borderRadius: radii.xl - 2,
      minWidth: 64,
    },
    bubbleOwn: { borderBottomRightRadius: radii.xl - 2 },
    bubbleOther: { borderBottomLeftRadius: radii.xl - 2 },
    bubbleOwnTail: { borderBottomRightRadius: radii.xs },
    bubbleOtherTail: { borderBottomLeftRadius: radii.xs },
    bubbleSending: { opacity: 0.75 },
    bubbleFailed: { opacity: 0.85, borderWidth: 1, borderColor: colors.error },
    flash: {
      ...({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const),
      borderRadius: radii.xl - 2,
    },
    senderName: {
      fontSize: typography.size.body2,
      fontWeight: typography.weight.semibold,
      color: colors.purple,
      marginBottom: 2,
    },
    text: { fontSize: typography.size.md, lineHeight: 20 },
    deleted: { fontStyle: "italic" },
    meta: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-end",
      gap: 3,
      marginTop: 2,
    },
    time: { fontSize: typography.size.xs + 1, fontVariant: ["tabular-nums"] },
    tail: {
      position: "absolute",
      bottom: 0,
      width: TAIL_SIZE,
      height: TAIL_SIZE,
    },
    tailOwn: { right: -4, borderTopLeftRadius: TAIL_SIZE, transform: [{ skewX: "-30deg" }] },
    tailOther: { left: -4, borderTopRightRadius: TAIL_SIZE, transform: [{ skewX: "30deg" }] },
    failedText: {
      fontSize: typography.size.sm,
      color: colors.error,
      marginTop: 3,
      marginHorizontal: spacing.xs,
    },
    seen: {
      fontSize: typography.size.sm,
      color: colors.text.secondary,
      marginTop: 3,
      marginHorizontal: spacing.xs,
    },
    systemRow: {
      alignItems: "center",
      marginVertical: spacing.sm,
      paddingHorizontal: spacing.xl,
    },
    systemText: {
      fontSize: typography.size.sm,
      color: colors.text.secondary,
      textAlign: "center",
      backgroundColor: colors.background.surface,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radii.full,
      overflow: "hidden",
    },
  }));
