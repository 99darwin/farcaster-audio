import { FlatList, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { LeaderboardRow } from "@/components/leaderboard/LeaderboardRow";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { ErrorView } from "@/components/common/ErrorView";
import { TabStrip, type TabStripItem } from "@/components/search/TabStrip";
import { useLeaderboard } from "@/hooks/useLeaderboard";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { spacing, typography } from "@/constants/theme";
import {
  CATEGORY_LABELS,
  currentCycle,
  formatCycleLabel,
  formatScore,
  type LeaderboardCategoryKey,
} from "@/services/leaderboard";

export default function LeaderboardScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useStyles();
  const {
    cycle,
    data,
    isLoading,
    error,
    categoryOrder,
    activeCategory,
    setActiveCategory,
    activeEntries,
    isEmpty,
    canGoNext,
    canGoPrevious,
    goToPreviousCycle,
    goToNextCycle,
    refresh,
    standing,
  } = useLeaderboard();

  const tabs: TabStripItem<LeaderboardCategoryKey>[] = categoryOrder.map(
    (key) => ({
      key,
      label:
        data?.categories.find((category) => category.key === key)?.label ??
        CATEGORY_LABELS[key],
    }),
  );

  const openProfile = (fid: number) => router.push(`/profile/${fid}`);

  // "First cycle in progress" only fits the live current cycle; a past
  // cycle with no entries simply has none.
  const emptyCopy =
    cycle === currentCycle()
      ? "First cycle in progress"
      : "No entries for this cycle";

  return (
    <View style={styles.container}>
      <View style={styles.cycleSwitcher}>
        <Pressable
          onPress={goToPreviousCycle}
          disabled={!canGoPrevious}
          accessibilityRole="button"
          accessibilityLabel="Previous cycle"
          accessibilityState={{ disabled: !canGoPrevious }}
          style={styles.cycleButton}
        >
          <Ionicons
            name="chevron-back"
            size={20}
            color={
              canGoPrevious ? colors.text.secondary : colors.text.placeholder
            }
          />
        </Pressable>
        <View style={styles.cycleLabelWrap}>
          <Text style={styles.cycleLabel}>{formatCycleLabel(cycle)}</Text>
          {data?.status === "provisional" && (
            <View style={styles.provisionalPill}>
              <Text style={styles.provisionalText}>Provisional</Text>
            </View>
          )}
        </View>
        <Pressable
          onPress={goToNextCycle}
          disabled={!canGoNext}
          accessibilityRole="button"
          accessibilityLabel="Next cycle"
          accessibilityState={{ disabled: !canGoNext }}
          style={styles.cycleButton}
        >
          <Ionicons
            name="chevron-forward"
            size={20}
            color={canGoNext ? colors.text.secondary : colors.text.placeholder}
          />
        </Pressable>
      </View>

      {standing && standing.cycle === cycle && (
        <View style={styles.standingSection}>
          <Text style={styles.standingTitle}>Your standing</Text>
          <View style={styles.standingRow}>
            {standing.categories.map((category) => (
              <View key={category.key} style={styles.standingCard}>
                <Text style={styles.standingCardLabel} numberOfLines={1}>
                  {CATEGORY_LABELS[category.key]}
                </Text>
                <Text style={styles.standingCardValue}>
                  {category.rank ? `#${category.rank}` : "Unranked"}
                </Text>
                <Text style={styles.standingCardScore}>
                  {formatScore(category.score)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      )}

      <TabStrip
        tabs={tabs}
        activeKey={activeCategory}
        onChange={setActiveCategory}
      />

      {isLoading && !data ? (
        <LoadingSpinner fullScreen />
      ) : error && !data ? (
        <ErrorView message={error} onRetry={refresh} fullScreen />
      ) : isEmpty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>{emptyCopy}</Text>
        </View>
      ) : (
        <FlatList
          data={activeEntries}
          keyExtractor={(entry) => `${entry.fid}`}
          renderItem={({ item }) => (
            <LeaderboardRow entry={item} onPress={openProfile} />
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                No entries in this category yet
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
    },
    cycleSwitcher: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
    },
    cycleButton: {
      width: 36,
      height: 36,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    cycleLabelWrap: {
      alignItems: "center" as const,
      gap: spacing.xs,
    },
    cycleLabel: {
      color: colors.text.primary,
      fontSize: typography.size.lg,
      fontWeight: typography.weight.bold,
    },
    provisionalPill: {
      backgroundColor: colors.background.subtle,
      borderRadius: 999,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
    },
    provisionalText: {
      color: colors.text.secondary,
      fontSize: typography.size.xs,
      fontWeight: typography.weight.semibold,
      textTransform: "uppercase" as const,
      letterSpacing: 0.5,
    },
    standingSection: {
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    standingTitle: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      fontWeight: typography.weight.semibold,
      textTransform: "uppercase" as const,
      letterSpacing: 0.5,
      marginBottom: spacing.sm,
    },
    standingRow: {
      flexDirection: "row" as const,
      gap: spacing.sm,
    },
    standingCard: {
      flex: 1,
      backgroundColor: colors.background.surface,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.background.border,
      padding: spacing.sm,
      alignItems: "center" as const,
    },
    standingCardLabel: {
      color: colors.text.secondary,
      fontSize: typography.size.xs,
      fontWeight: typography.weight.semibold,
    },
    standingCardValue: {
      color: colors.text.primary,
      fontSize: typography.size.lg,
      fontWeight: typography.weight.bold,
      marginTop: 2,
    },
    standingCardScore: {
      color: colors.text.secondary,
      fontSize: typography.size.xs,
      marginTop: 1,
    },
    empty: {
      alignItems: "center" as const,
      paddingTop: spacing["4xl"],
    },
    emptyText: {
      color: colors.text.secondary,
      fontSize: typography.size.md,
    },
  }));
