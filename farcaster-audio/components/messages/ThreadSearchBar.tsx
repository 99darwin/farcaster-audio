/**
 * In-thread search header: query field, "3 of 12" position and up/down
 * navigation (up = older match).
 */

import { memo } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, touchTarget, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface ThreadSearchBarProps {
  query: string;
  /** Zero-based index into matches, newest first; -1 when none. */
  activeIndex: number;
  matchCount: number;
  isSearching: boolean;
  onChangeQuery: (query: string) => void;
  onOlder: () => void;
  onNewer: () => void;
  onClose: () => void;
}

export function formatMatchPosition(activeIndex: number, matchCount: number): string {
  if (matchCount === 0 || activeIndex < 0) return "0 of 0";
  return `${activeIndex + 1} of ${matchCount}`;
}

function ThreadSearchBarImpl({
  query,
  activeIndex,
  matchCount,
  isSearching,
  onChangeQuery,
  onOlder,
  onNewer,
  onClose,
}: ThreadSearchBarProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const canGoOlder = matchCount > 0 && activeIndex < matchCount - 1;
  const canGoNewer = matchCount > 0 && activeIndex > 0;
  const hasQuery = query.trim().length > 0;

  return (
    <View style={styles.container} testID="thread-search-bar">
      <View style={styles.field}>
        <Ionicons name="search" size={16} color={colors.text.secondary} />
        <TextInput
          value={query}
          onChangeText={onChangeQuery}
          placeholder="Search this chat"
          placeholderTextColor={colors.text.placeholder}
          style={styles.input}
          autoFocus
          returnKeyType="search"
          autoCorrect={false}
          accessibilityLabel="Search this chat"
          testID="thread-search-input"
        />
        {isSearching ? <ActivityIndicator size="small" color={colors.text.secondary} /> : null}
      </View>
      {hasQuery ? (
        <Text style={styles.position} testID="thread-search-position">
          {formatMatchPosition(activeIndex, matchCount)}
        </Text>
      ) : null}
      <Pressable
        onPress={onOlder}
        disabled={!canGoOlder}
        style={styles.navButton}
        accessibilityLabel="Previous match"
        accessibilityState={{ disabled: !canGoOlder }}
        testID="thread-search-older"
      >
        <Ionicons
          name="chevron-up"
          size={20}
          color={canGoOlder ? colors.text.primary : colors.text.placeholder}
        />
      </Pressable>
      <Pressable
        onPress={onNewer}
        disabled={!canGoNewer}
        style={styles.navButton}
        accessibilityLabel="Next match"
        accessibilityState={{ disabled: !canGoNewer }}
        testID="thread-search-newer"
      >
        <Ionicons
          name="chevron-down"
          size={20}
          color={canGoNewer ? colors.text.primary : colors.text.placeholder}
        />
      </Pressable>
      <Pressable onPress={onClose} style={styles.navButton} accessibilityLabel="Close search">
        <Text style={styles.cancel}>Done</Text>
      </Pressable>
    </View>
  );
}

export const ThreadSearchBar = memo(ThreadSearchBarImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
      flex: 1,
    },
    field: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      height: 36,
      borderRadius: radii.full,
      backgroundColor: colors.background.surface,
    },
    input: {
      flex: 1,
      color: colors.text.primary,
      fontSize: typography.size.md,
      paddingVertical: 0,
    },
    position: {
      fontSize: typography.size.body2,
      color: colors.text.secondary,
      fontVariant: ["tabular-nums"],
      marginLeft: spacing.xs,
    },
    navButton: {
      minWidth: touchTarget.min - 8,
      height: touchTarget.min,
      alignItems: "center",
      justifyContent: "center",
    },
    cancel: {
      color: colors.purple,
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
    },
  }));
