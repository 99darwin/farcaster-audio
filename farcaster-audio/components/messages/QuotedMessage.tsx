/**
 * The quoted parent shown inside a reply bubble and above the composer.
 */

import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { radii, spacing, typography, withAlpha } from "@/constants/theme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { userDisplayName } from "@/components/messages/userDisplayName";
import type { MessageQuote } from "@/types/messages";
import { ON_ACCENT } from "@/components/messages/bubbleColors";

interface QuotedMessageProps {
  quote: MessageQuote;
  /** Bubble variant: sits on the purple own-bubble background. */
  isOnAccent: boolean;
  onPress?: () => void;
}

function QuotedMessageImpl({ quote, isOnAccent, onPress }: QuotedMessageProps) {
  const styles = useStyles();
  const name = userDisplayName(quote.sender, "Someone");
  const body = quote.is_deleted ? "Message deleted" : quote.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.container,
        isOnAccent ? styles.containerOnAccent : styles.containerDefault,
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`Reply to ${name}: ${body}. Jump to message`}
      testID={`quote-${quote.message_id}`}
    >
      <View style={[styles.bar, isOnAccent && styles.barOnAccent]} />
      <View style={styles.body}>
        <Text
          style={[styles.name, isOnAccent && styles.nameOnAccent]}
          numberOfLines={1}
        >
          {name}
        </Text>
        <Text
          style={[
            styles.text,
            isOnAccent && styles.textOnAccent,
            quote.is_deleted && styles.deleted,
          ]}
          numberOfLines={2}
        >
          {body}
        </Text>
      </View>
    </Pressable>
  );
}

export const QuotedMessage = memo(QuotedMessageImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row",
      borderRadius: radii.sm,
      overflow: "hidden",
      marginBottom: spacing.xs,
    },
    containerDefault: { backgroundColor: withAlpha(colors.purple, 0.12) },
    containerOnAccent: { backgroundColor: withAlpha(ON_ACCENT, 0.16) },
    pressed: { opacity: 0.7 },
    bar: { width: 3, backgroundColor: colors.purple },
    barOnAccent: { backgroundColor: ON_ACCENT },
    body: { flex: 1, paddingHorizontal: spacing.sm, paddingVertical: 5 },
    name: {
      fontSize: typography.size.body2,
      fontWeight: typography.weight.semibold,
      color: colors.purple,
    },
    nameOnAccent: { color: ON_ACCENT },
    text: { fontSize: typography.size.body2, color: colors.text.body },
    textOnAccent: { color: withAlpha(ON_ACCENT, 0.9) },
    deleted: { fontStyle: "italic" },
  }));
