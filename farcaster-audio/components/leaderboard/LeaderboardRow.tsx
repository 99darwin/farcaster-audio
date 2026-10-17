import { Pressable, Text, View } from "react-native";
import { Avatar } from "@/components/common/Avatar";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { spacing, typography } from "@/constants/theme";
import { formatScore, type LeaderboardEntry } from "@/services/leaderboard";

interface LeaderboardRowProps {
  entry: LeaderboardEntry;
  onPress: (fid: number) => void;
}

const TOP_RANK_COLORS: Record<number, string> = {
  1: "#E5B93C",
  2: "#B9C0CE",
  3: "#C77A3F",
};

export function LeaderboardRow({ entry, onPress }: LeaderboardRowProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const rankColor = TOP_RANK_COLORS[entry.rank];
  const isTopThree = Boolean(rankColor);
  // Ledger-scored fids without a `users` row come back with a null
  // username/display_name from the outer-join — fall back like the rest
  // of the app does (see hooks/useSpace.ts, app/space/create.tsx).
  const resolvedName =
    entry.display_name || entry.username || `User ${entry.fid}`;

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={() => onPress(entry.fid)}
      accessibilityRole="button"
      accessibilityLabel={`Rank ${entry.rank}, ${resolvedName}, score ${formatScore(entry.score)}`}
    >
      <View
        style={[
          styles.rankWrap,
          isTopThree && { backgroundColor: `${rankColor}26` },
        ]}
      >
        <Text
          style={[
            styles.rankText,
            isTopThree && { color: rankColor, fontWeight: typography.weight.bold },
          ]}
        >
          {entry.rank}
        </Text>
      </View>
      <Avatar pfpUrl={entry.pfp_url} displayName={resolvedName} size="sm" />
      <View style={styles.nameWrap}>
        <Text style={styles.displayName} numberOfLines={1}>
          {resolvedName}
        </Text>
        {entry.username && (
          <Text style={styles.username} numberOfLines={1}>
            @{entry.username}
          </Text>
        )}
      </View>
      <Text style={[styles.score, isTopThree && { color: colors.text.primary }]}>
        {formatScore(entry.score)}
      </Text>
    </Pressable>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    pressed: {
      opacity: 0.62,
    },
    rankWrap: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    rankText: {
      color: colors.text.secondary,
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
    },
    nameWrap: {
      flex: 1,
      minWidth: 0,
    },
    displayName: {
      color: colors.text.primary,
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
    },
    username: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      marginTop: 1,
    },
    score: {
      color: colors.text.secondary,
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
    },
  }));
