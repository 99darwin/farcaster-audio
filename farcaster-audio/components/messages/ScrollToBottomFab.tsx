/**
 * Floating "jump to latest" button with a count of messages that arrived
 * while scrolled up.
 */

import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { ON_ACCENT } from "@/components/messages/bubbleColors";

const FAB_SIZE = 40;
const MAX_BADGE = 99;

interface ScrollToBottomFabProps {
  isVisible: boolean;
  unreadCount: number;
  onPress: () => void;
}

function ScrollToBottomFabImpl({ isVisible, unreadCount, onPress }: ScrollToBottomFabProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  if (!isVisible) return null;
  const label = unreadCount > MAX_BADGE ? `${MAX_BADGE}+` : String(unreadCount);
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.fab, pressed && styles.pressed]}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={
        unreadCount > 0 ? `Scroll to latest, ${unreadCount} new messages` : "Scroll to latest"
      }
      testID="scroll-to-bottom"
    >
      <Ionicons name="chevron-down" size={22} color={colors.text.primary} />
      {unreadCount > 0 ? (
        <View style={styles.badge} testID="scroll-to-bottom-badge">
          <Text style={styles.badgeText}>{label}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

export const ScrollToBottomFab = memo(ScrollToBottomFabImpl);

const useStyles = () =>
  useThemedStyles(({ colors, glass }) => ({
    fab: {
      position: "absolute",
      right: spacing.lg,
      bottom: spacing.md,
      width: FAB_SIZE,
      height: FAB_SIZE,
      borderRadius: FAB_SIZE / 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.background.surface,
      borderWidth: 1,
      borderColor: glass.borderColor,
      shadowColor: glass.shadow.color,
      shadowOffset: glass.shadow.offset,
      shadowOpacity: glass.shadow.opacity,
      shadowRadius: glass.shadow.radius / 2,
      elevation: 4,
    },
    pressed: { opacity: 0.8 },
    badge: {
      position: "absolute",
      top: -6,
      minWidth: 20,
      height: 20,
      paddingHorizontal: 5,
      borderRadius: radii.full,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.purple,
    },
    badgeText: {
      color: ON_ACCENT,
      fontSize: typography.size.xs + 1,
      fontWeight: typography.weight.bold,
    },
  }));
