import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

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
  onReply: () => void;
}

export function CastActions({
  likesCount,
  recastsCount,
  repliesCount,
  isLiked,
  isRecasted,
  onLike,
  onRecast,
  onReply,
}: CastActionsProps) {
  return (
    <View style={styles.container}>
      <Pressable
        onPress={onLike}
        style={styles.action}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel={`Like, ${formatCount(likesCount)}`}
        accessibilityRole="button"
      >
        <Ionicons
          name={isLiked ? 'heart' : 'heart-outline'}
          size={18}
          color={isLiked ? '#ef4444' : '#8888aa'}
        />
        <Text style={[styles.count, isLiked && styles.activeCount]}>{formatCount(likesCount)}</Text>
      </Pressable>

      <Pressable
        onPress={onRecast}
        style={styles.action}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel={`Recast, ${formatCount(recastsCount)}`}
        accessibilityRole="button"
      >
        <Ionicons
          name="repeat"
          size={18}
          color={isRecasted ? '#22c55e' : '#8888aa'}
        />
        <Text style={[styles.count, isRecasted && styles.recastActive]}>{formatCount(recastsCount)}</Text>
      </Pressable>

      <Pressable
        onPress={onReply}
        style={styles.action}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel={`Reply, ${formatCount(repliesCount)}`}
        accessibilityRole="button"
      >
        <Ionicons name="chatbubble-outline" size={16} color="#8888aa" />
        <Text style={styles.count}>{formatCount(repliesCount)}</Text>
      </Pressable>
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
    gap: 4,
  },
  count: {
    fontSize: 13,
    color: '#8888aa',
  },
  activeCount: {
    color: '#ef4444',
  },
  recastActive: {
    color: '#22c55e',
  },
});
