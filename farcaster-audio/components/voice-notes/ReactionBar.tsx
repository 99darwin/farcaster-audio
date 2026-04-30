import { View, Text, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { touchTarget, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { formatCount } from "@/utils/format";
import { haptic } from "@/utils/haptics";

interface ReactionBarProps {
  likeCount: number;
  recastCount: number;
  playCount: number;
  isLiked: boolean;
  isRecasted: boolean;
  onLike: () => void;
  onRecast: () => void;
  onShare: () => void;
}

export function ReactionBar({
  likeCount,
  recastCount,
  playCount,
  isLiked,
  isRecasted,
  onLike,
  onRecast,
  onShare,
}: ReactionBarProps) {
  const { colors } = useTheme();
  const styles = useStyles();

  return (
    <View style={styles.container}>
      <View style={styles.playCount}>
        <Text style={styles.playCountText}>{formatCount(playCount)} plays</Text>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={() => {
            haptic.light();
            onLike();
          }}
          style={styles.action}
          accessibilityLabel={`Like, ${likeCount}`}
          accessibilityRole="button"
        >
          <Ionicons
            name={isLiked ? "heart" : "heart-outline"}
            size={18}
            color={isLiked ? colors.error : colors.text.secondary}
          />
          <Text style={[styles.count, isLiked && styles.likeActive]}>
            {formatCount(likeCount)}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => {
            haptic.light();
            onRecast();
          }}
          style={styles.action}
          accessibilityLabel={`Recast, ${recastCount}`}
          accessibilityRole="button"
        >
          <Ionicons
            name="repeat"
            size={18}
            color={isRecasted ? colors.success : colors.text.secondary}
          />
          <Text style={[styles.count, isRecasted && styles.recastActive]}>
            {formatCount(recastCount)}
          </Text>
        </Pressable>

        <Pressable
          onPress={() => {
            haptic.selection();
            onShare();
          }}
          style={styles.action}
          accessibilityLabel="Share"
          accessibilityRole="button"
        >
          <Ionicons
            name="share-outline"
            size={16}
            color={colors.text.secondary}
          />
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingTop: 8,
    },
    playCount: {
      flexDirection: "row",
      alignItems: "center",
    },
    playCountText: {
      fontSize: typography.size.sm,
      color: colors.text.placeholder,
    },
    actions: {
      flexDirection: "row",
      gap: 20,
    },
    action: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      minWidth: touchTarget.min,
      minHeight: touchTarget.min,
      justifyContent: "center",
    },
    count: {
      fontSize: 13,
      color: colors.text.secondary,
    },
    likeActive: {
      color: colors.error,
    },
    recastActive: {
      color: colors.success,
    },
  }));
