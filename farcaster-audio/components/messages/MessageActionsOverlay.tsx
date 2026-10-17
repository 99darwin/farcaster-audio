/**
 * Long-press overlay for a bubble: a quick-reaction bar (with "more" emoji
 * grid) and a context menu (reply, copy, delete own), anchored to the
 * bubble's window rect and clamped to the safe area.
 */

import { useEffect, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radii, spacing, typography, withAlpha } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { BubbleRect } from "@/components/messages/MessageBubble";
import type { Message } from "@/types/messages";

const QUICK_REACTIONS = ["❤️", "👍", "😂", "😮", "😢", "🔥"] as const;
export const DOUBLE_TAP_REACTION = QUICK_REACTIONS[0];
const MORE_REACTIONS = [
  "😀", "😁", "🤣", "😊", "😍", "🥰", "😘", "😎", "🤩", "🥳",
  "🤔", "🫡", "🙃", "😅", "😭", "😤", "😡", "🤯", "😱", "🥺",
  "👏", "🙌", "🙏", "💪", "🤝", "👀", "👎", "✌️", "🤞", "🫶",
  "💜", "🧡", "💯", "✨", "🎉", "🚀", "🎧", "🎶", "🎤", "☕",
] as const;

const GUTTER = spacing.lg;
const GAP = spacing.sm;
const BAR_HEIGHT = 52;
const MENU_WIDTH = 220;
const MENU_ROW_HEIGHT = 46;
const EMOJI_GRID_HEIGHT = 228;

interface MessageActionsOverlayProps {
  message: Message | null;
  anchor: BubbleRect | null;
  isOwn: boolean;
  onReact: (message: Message, reaction: string) => void;
  onReply: (message: Message) => void;
  onCopy: (message: Message) => void;
  onDelete: (message: Message) => void;
  onDismiss: () => void;
}

interface MenuAction {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  isDestructive?: boolean;
  run: (message: Message) => void;
}

export function MessageActionsOverlay({
  message,
  anchor,
  isOwn,
  onReact,
  onReply,
  onCopy,
  onDelete,
  onDismiss,
}: MessageActionsOverlayProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const [isShowingMore, setIsShowingMore] = useState(false);

  useEffect(() => {
    if (!message) setIsShowingMore(false);
  }, [message]);

  if (!message || !anchor) return null;

  const actions: MenuAction[] = [
    { key: "reply", label: "Reply", icon: "arrow-undo-outline", run: onReply },
  ];
  if (message.text.trim()) {
    actions.push({ key: "copy", label: "Copy text", icon: "copy-outline", run: onCopy });
  }
  if (isOwn) {
    actions.push({
      key: "delete",
      label: "Delete",
      icon: "trash-outline",
      isDestructive: true,
      run: onDelete,
    });
  }

  const viewerReactions = new Set(
    message.reactions.filter((r) => r.viewer_reacted).map((r) => r.reaction),
  );
  const barHeight = isShowingMore ? EMOJI_GRID_HEIGHT : BAR_HEIGHT;
  const menuHeight = actions.length * MENU_ROW_HEIGHT;
  const safeTop = insets.top + GAP;
  const safeBottom = screenHeight - insets.bottom - GAP;

  // Prefer: bar above the bubble, menu below. Clamp into the safe area.
  let barTop = anchor.y - barHeight - GAP;
  let menuTop = anchor.y + anchor.height + GAP;
  if (barTop < safeTop) barTop = safeTop;
  if (menuTop + menuHeight > safeBottom) {
    menuTop = Math.max(barTop + barHeight + GAP, safeBottom - menuHeight);
  }
  const barWidth = Math.min(screenWidth - GUTTER * 2, isShowingMore ? 340 : 320);
  const alignLeft = (width: number) => {
    const preferred = isOwn ? anchor.x + anchor.width - width : anchor.x;
    return Math.min(Math.max(GUTTER, preferred), screenWidth - GUTTER - width);
  };

  const handleReact = (reaction: string) => {
    onReact(message, reaction);
    onDismiss();
  };

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
      statusBarTranslucent
    >
      <Pressable
        style={[styles.backdrop, { backgroundColor: withAlpha(colors.background.main, 0.55) }]}
        onPress={onDismiss}
        accessibilityLabel="Close message actions"
        testID="message-actions-backdrop"
      />
      <View
        style={[styles.bar, { top: barTop, left: alignLeft(barWidth), width: barWidth }]}
        testID="reaction-bar"
      >
        {isShowingMore ? (
          <ScrollView contentContainerStyle={styles.grid}>
            {MORE_REACTIONS.map((emoji) => (
              <Pressable
                key={emoji}
                onPress={() => handleReact(emoji)}
                style={({ pressed }) => [
                  styles.gridCell,
                  viewerReactions.has(emoji) && styles.emojiActive,
                  pressed && styles.emojiPressed,
                ]}
                accessibilityLabel={`React with ${emoji}`}
              >
                <Text style={styles.emoji}>{emoji}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : (
          <View style={styles.quickRow}>
            {QUICK_REACTIONS.map((emoji) => (
              <Pressable
                key={emoji}
                onPress={() => handleReact(emoji)}
                style={({ pressed }) => [
                  styles.quickCell,
                  viewerReactions.has(emoji) && styles.emojiActive,
                  pressed && styles.emojiPressed,
                ]}
                accessibilityLabel={`React with ${emoji}`}
                testID={`quick-reaction-${emoji}`}
              >
                <Text style={styles.emoji}>{emoji}</Text>
              </Pressable>
            ))}
            <Pressable
              onPress={() => setIsShowingMore(true)}
              style={({ pressed }) => [styles.quickCell, pressed && styles.emojiPressed]}
              accessibilityLabel="More reactions"
              testID="more-reactions"
            >
              <Ionicons name="add" size={22} color={colors.text.secondary} />
            </Pressable>
          </View>
        )}
      </View>
      <View
        style={[styles.menu, { top: menuTop, left: alignLeft(MENU_WIDTH) }]}
        testID="message-menu"
      >
        {actions.map((action, index) => (
          <Pressable
            key={action.key}
            onPress={() => {
              onDismiss();
              action.run(message);
            }}
            style={({ pressed }) => [
              styles.menuRow,
              index > 0 && styles.menuDivider,
              pressed && styles.menuPressed,
            ]}
            accessibilityRole="button"
            testID={`message-action-${action.key}`}
          >
            <Text style={[styles.menuLabel, action.isDestructive && styles.destructive]}>
              {action.label}
            </Text>
            <Ionicons
              name={action.icon}
              size={18}
              color={action.isDestructive ? colors.error : colors.text.primary}
            />
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors, glass }) => ({
    backdrop: { ...({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const) },
    bar: {
      position: "absolute",
      borderRadius: radii["2xl"],
      backgroundColor: colors.background.surface,
      borderWidth: 1,
      borderColor: glass.borderColor,
      shadowColor: glass.shadow.color,
      shadowOffset: glass.shadow.offset,
      shadowOpacity: glass.shadow.opacity,
      shadowRadius: glass.shadow.radius,
      elevation: 8,
      overflow: "hidden",
    },
    quickRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      height: BAR_HEIGHT,
      paddingHorizontal: spacing.xs,
    },
    quickCell: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
    },
    grid: {
      flexDirection: "row",
      flexWrap: "wrap",
      padding: spacing.sm,
      justifyContent: "center",
    },
    gridCell: {
      width: 44,
      height: 44,
      borderRadius: 22,
      alignItems: "center",
      justifyContent: "center",
    },
    emoji: { fontSize: 26 },
    emojiActive: { backgroundColor: withAlpha(colors.purple, 0.22) },
    emojiPressed: { transform: [{ scale: 1.15 }] },
    menu: {
      position: "absolute",
      width: MENU_WIDTH,
      borderRadius: radii.lg,
      backgroundColor: colors.background.surface,
      borderWidth: 1,
      borderColor: glass.borderColor,
      shadowColor: glass.shadow.color,
      shadowOffset: glass.shadow.offset,
      shadowOpacity: glass.shadow.opacity,
      shadowRadius: glass.shadow.radius,
      elevation: 8,
      overflow: "hidden",
    },
    menuRow: {
      height: MENU_ROW_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: spacing.lg,
    },
    menuDivider: {
      borderTopWidth: 1,
      borderTopColor: colors.background.border,
    },
    menuPressed: { backgroundColor: colors.background.border },
    menuLabel: {
      fontSize: typography.size.md,
      color: colors.text.primary,
    },
    destructive: { color: colors.error },
  }));
