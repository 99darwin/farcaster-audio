import { View, Text, Pressable, ActionSheetIOS, Share, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, touchTarget } from '@/constants/theme';

function formatCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

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
  const handleRecastPress = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ['Cancel', isRecasted ? 'Undo Recast' : 'Recast', 'Quote Cast'],
        cancelButtonIndex: 0,
      },
      (buttonIndex) => {
        if (buttonIndex === 1) onRecast();
        if (buttonIndex === 2) onQuoteCast();
      },
    );
  };

  const handleSharePress = () => {
    if (!authorUsername || !castHash) return;
    const url = buildWarpcastUrl(authorUsername, castHash);
    Share.share({ url });
  };

  return (
    <View style={styles.container}>
      <Pressable
        onPress={onReply}
        style={styles.action}
        accessibilityLabel={`Reply, ${formatCount(repliesCount)}`}
        accessibilityRole="button"
      >
        <Ionicons name="chatbubble-outline" size={16} color={colors.text.secondary} />
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
        <Text style={[styles.count, isRecasted && styles.recastActive]}>{formatCount(recastsCount)}</Text>
      </Pressable>

      <Pressable
        onPress={onLike}
        style={styles.action}
        accessibilityLabel={`Like, ${formatCount(likesCount)}`}
        accessibilityRole="button"
      >
        <Ionicons
          name={isLiked ? 'heart' : 'heart-outline'}
          size={18}
          color={isLiked ? colors.error : colors.text.secondary}
        />
        <Text style={[styles.count, isLiked && styles.activeCount]}>{formatCount(likesCount)}</Text>
      </Pressable>

      {authorUsername && castHash && (
        <Pressable
          onPress={handleSharePress}
          style={styles.action}
          accessibilityLabel="Share"
          accessibilityRole="button"
        >
          <Ionicons name="share-outline" size={16} color={colors.text.secondary} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: 24,
    paddingTop: 8,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
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
});
