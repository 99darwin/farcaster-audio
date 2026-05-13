import { Pressable, StyleSheet, Text, View } from "react-native";
import { radii, spacing, typography } from "@/constants/theme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

export type CastSort = "popular" | "recent";

interface CastSortToggleProps {
  value: CastSort;
  onChange: (next: CastSort) => void;
}

const OPTIONS: Array<{ key: CastSort; label: string }> = [
  { key: "popular", label: "Popular" },
  { key: "recent", label: "Recent" },
];

export function CastSortToggle({ value, onChange }: CastSortToggleProps) {
  const styles = useStyles();
  return (
    <View style={styles.container}>
      <View style={styles.segment}>
        {OPTIONS.map((opt) => {
          const isActive = opt.key === value;
          return (
            <Pressable
              key={opt.key}
              onPress={() => onChange(opt.key)}
              style={[styles.pill, isActive && styles.pillActive]}
              accessibilityRole="button"
              accessibilityState={{ selected: isActive }}
              accessibilityLabel={`${opt.label} casts`}
            >
              <Text style={[styles.label, isActive && styles.labelActive]}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
      backgroundColor: colors.background.main,
    },
    segment: {
      flexDirection: "row" as const,
      backgroundColor: colors.background.subtle,
      borderRadius: radii.full,
      padding: 2,
      alignSelf: "flex-start" as const,
    },
    pill: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xs + 2,
      borderRadius: radii.full,
    },
    pillActive: {
      backgroundColor: colors.accent,
    },
    label: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      fontWeight: typography.weight.semibold,
    },
    labelActive: {
      color: "#ffffff",
    },
  }));
