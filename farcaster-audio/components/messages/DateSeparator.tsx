import { memo } from "react";
import { Text, View } from "react-native";
import { radii, spacing, typography } from "@/constants/theme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { formatDaySeparator } from "@/utils/messageTime";

function DateSeparatorImpl({ timestamp }: { timestamp: number }) {
  const styles = useStyles();
  return (
    <View style={styles.row} accessibilityRole="header">
      <Text style={styles.label}>{formatDaySeparator(timestamp)}</Text>
    </View>
  );
}

export const DateSeparator = memo(DateSeparatorImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: { alignItems: "center", marginVertical: spacing.md },
    label: {
      fontSize: typography.size.sm,
      fontWeight: typography.weight.semibold,
      color: colors.text.secondary,
      backgroundColor: colors.background.surface,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radii.full,
      overflow: "hidden",
    },
  }));
