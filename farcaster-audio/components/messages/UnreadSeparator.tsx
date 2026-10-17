/** "New messages" divider placed above the oldest unread message on open. */

import { memo } from "react";
import { Text, View } from "react-native";
import { spacing, typography, withAlpha } from "@/constants/theme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

function UnreadSeparatorImpl() {
  const styles = useStyles();
  return (
    <View style={styles.row} accessibilityRole="header" testID="unread-separator">
      <Text style={styles.label}>New messages</Text>
    </View>
  );
}

export const UnreadSeparator = memo(UnreadSeparatorImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      alignItems: "center",
      marginVertical: spacing.sm,
      paddingVertical: spacing.xs,
      backgroundColor: withAlpha(colors.purple, 0.1),
    },
    label: {
      fontSize: typography.size.sm,
      fontWeight: typography.weight.semibold,
      color: colors.purple,
    },
  }));
