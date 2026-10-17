import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { spacing, typography } from "@/constants/theme";
import {
  formatCycleLabel,
  getLeaderboardAwards,
  type LeaderboardAward,
} from "@/services/leaderboard";

interface LeaderboardAwardBadgesProps {
  fid: number;
}

/**
 * Recognition chips on a profile, e.g. "Top Host — June 2026". Status-only —
 * never implies a payout. Renders nothing while loading, on error, or when
 * the user has no awards, so it never leaves an empty gap in the profile
 * layout.
 */
export function LeaderboardAwardBadges({ fid }: LeaderboardAwardBadgesProps) {
  const styles = useStyles();
  const [awards, setAwards] = useState<LeaderboardAward[]>([]);

  useEffect(() => {
    let cancelled = false;
    setAwards([]);
    getLeaderboardAwards(fid)
      .then((response) => {
        if (!cancelled) setAwards(response.awards);
      })
      .catch(() => {
        if (!cancelled) setAwards([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fid]);

  if (awards.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.row}
    >
      {awards.map((award) => (
        <View
          key={`${award.cycle}-${award.category}`}
          style={styles.chip}
          accessible
          accessibilityLabel={`${award.label} — ${formatCycleLabel(award.cycle)}`}
        >
          <Text style={styles.chipText} numberOfLines={1}>
            {award.label} — {formatCycleLabel(award.cycle)}
          </Text>
        </View>
      ))}
    </ScrollView>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    scroll: {
      marginTop: spacing.sm,
    },
    row: {
      flexDirection: "row" as const,
      gap: spacing.sm,
    },
    chip: {
      backgroundColor: colors.background.subtle,
      borderRadius: 999,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderWidth: 1,
      borderColor: colors.purple,
    },
    chipText: {
      color: colors.text.primary,
      fontSize: typography.size.sm,
      fontWeight: typography.weight.semibold,
    },
  }));
