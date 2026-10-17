/**
 * Reaction summary chips under a bubble. Tapping a chip opens the
 * who-reacted sheet on that emoji's tab.
 */

import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { radii, spacing, typography, withAlpha } from "@/constants/theme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { formatCount } from "@/utils/format";
import type { MessageReactionSummary } from "@/types/messages";

interface ReactionChipsProps {
  reactions: MessageReactionSummary[];
  isOwn: boolean;
  onChipPress: (reaction: string) => void;
}

function ReactionChipsImpl({ reactions, isOwn, onChipPress }: ReactionChipsProps) {
  const styles = useStyles();
  if (reactions.length === 0) return null;
  return (
    <View style={[styles.row, isOwn ? styles.rowOwn : styles.rowOther]}>
      {reactions.map((reaction) => (
        <Pressable
          key={reaction.reaction}
          onPress={() => onChipPress(reaction.reaction)}
          style={({ pressed }) => [
            styles.chip,
            reaction.viewer_reacted && styles.chipActive,
            pressed && styles.chipPressed,
          ]}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={`${reaction.reaction} ${reaction.count}${
            reaction.viewer_reacted ? ", including you" : ""
          }. Show who reacted`}
          testID={`reaction-chip-${reaction.reaction}`}
        >
          <Text style={styles.emoji}>{reaction.reaction}</Text>
          <Text
            style={[styles.count, reaction.viewer_reacted && styles.countActive]}
          >
            {formatCount(reaction.count)}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export const ReactionChips = memo(ReactionChipsImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: spacing.xs,
      marginTop: -6,
      paddingHorizontal: spacing.sm,
    },
    rowOwn: { justifyContent: "flex-end" },
    rowOther: { justifyContent: "flex-start" },
    chip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderRadius: radii.full,
      backgroundColor: colors.background.surface,
      borderWidth: 1,
      borderColor: colors.background.border,
    },
    chipActive: {
      backgroundColor: withAlpha(colors.purple, 0.2),
      borderColor: colors.purple,
    },
    chipPressed: { opacity: 0.7 },
    emoji: { fontSize: typography.size.body },
    count: {
      fontSize: typography.size.sm,
      color: colors.text.secondary,
      fontWeight: typography.weight.semibold,
      fontVariant: ["tabular-nums"],
    },
    countActive: { color: colors.text.primary },
  }));
