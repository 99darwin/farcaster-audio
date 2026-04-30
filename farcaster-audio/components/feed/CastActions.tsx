import {
  View,
  Text,
  Pressable,
  ActionSheetIOS,
  Share,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { touchTarget } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { formatCount } from "@/utils/format";
import { haptic } from "@/utils/haptics";

interface CastActionsProps {
  likesCount: number;
  recastsCount: number;
  repliesCount: number;
  isLiked: boolean;
  isRecasted: boolean;
  onLike: () => void;
  onRecast: () => void;
  onQuoteCast: () => void;
  onReply: () => void;
  authorUsername?: string;
  castHash?: string;
}

function buildWarpcastUrl(username: string, hash: string): string {
  return `https://warpcast.com/${username}/${hash.slice(0, 10)}`;
}

export function CastActions({
  likesCount,
  recastsCount,
  repliesCount,
  isLiked,
  isRecasted,
  onLike,
  onRecast,
  onQuoteCast,
  onReply,
  authorUsername,
  castHash,
}: CastActionsProps) {
  const { colors } = useTheme();
  const styles = useStyles();

  const handleRecastPress = () => {
    haptic.selection();
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [
          "Cancel",
          isRecasted ? "Undo Recast" : "Recast",
          "Quote Cast",
        ],
        cancelButtonIndex: 0,
      },
      (buttonIndex) => {
        if (buttonIndex === 1) {
          haptic.light();
          onRecast();
        }
        if (buttonIndex === 2) {
          haptic.selection();
          onQuoteCast();
        }
      },
    );
  };

  const handleLikePress = () => {
    haptic.light();
    onLike();
  };

  const handleReplyPress = () => {
    haptic.selection();
    onReply();
  };

  const handleSharePress = () => {
    if (!authorUsername || !castHash) return;
    haptic.selection();
    const url = buildWarpcastUrl(authorUsername, castHash);
    Share.share({ url });
  };

  return (
    <View style={styles.container}>
      <Pressable
        onPress={handleReplyPress}
        style={styles.action}
        accessibilityLabel={`Reply, ${formatCount(repliesCount)}`}
        accessibilityRole="button"
      >
        <Ionicons
          name="chatbubble-outline"
          size={16}
          color={colors.text.secondary}
        />
        <Text style={styles.count}>{formatCount(repliesCount)}</Text>
      </Pressable>

      <Pressable
        onPress={handleRecastPress}
        style={styles.action}
        accessibilityLabel={`Recast, ${formatCount(recastsCount)}`}
        accessibilityRole="button"
      >
        <Ionicons
          name="repeat"
          size={18}
          color={isRecasted ? colors.success : colors.text.secondary}
        />
        <Text style={[styles.count, isRecasted && styles.recastActive]}>
          {formatCount(recastsCount)}
        </Text>
      </Pressable>

      <Pressable
        onPress={handleLikePress}
        style={styles.action}
        accessibilityLabel={`Like, ${formatCount(likesCount)}`}
        accessibilityRole="button"
      >
        <Ionicons
          name={isLiked ? "heart" : "heart-outline"}
          size={18}
          color={isLiked ? colors.error : colors.text.secondary}
        />
        <Text style={[styles.count, isLiked && styles.activeCount]}>
          {formatCount(likesCount)}
        </Text>
      </Pressable>

      {authorUsername && castHash && (
        <Pressable
          onPress={handleSharePress}
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
      )}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row" as const,
      gap: 24,
      paddingTop: 8,
    },
    action: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 4,
      minWidth: touchTarget.min,
      minHeight: touchTarget.min,
    },
    count: {
      fontSize: 13,
      color: colors.text.secondary,
    },
    activeCount: {
      color: colors.error,
    },
    recastActive: {
      color: colors.success,
    },
  }));
