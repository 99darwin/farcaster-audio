import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Avatar } from '@/components/common/Avatar';
import { colors, typography } from '@/constants/theme';
import type { NeynarNotification } from '@/types/neynar';

function getRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

const ACTION_TEXT: Record<string, string> = {
  likes: 'liked your cast',
  recasts: 'recasted your cast',
  follows: 'followed you',
  reply: 'replied to your cast',
  mention: 'mentioned you',
};

interface NotificationItemProps {
  notification: NeynarNotification;
  isUnread: boolean;
  onLike?: (hash: string, isLiked: boolean) => void;
}

export function NotificationItem({ notification, isUnread, onLike }: NotificationItemProps) {
  const router = useRouter();
  const { type, user, cast, timestamp } = notification;

  const handlePress = () => {
    if (type === 'follows') {
      router.push(`/profile/${user.fid}`);
    } else if (cast?.hash) {
      router.push(`/cast/${cast.hash}`);
    }
  };

  return (
    <Pressable
      style={[styles.container, isUnread && styles.unread]}
      onPress={handlePress}
      accessibilityLabel={`${user.display_name || user.username} ${ACTION_TEXT[type] ?? type}`}
    >
      <Avatar
        pfpUrl={user.pfp_url}
        displayName={user.display_name || user.username}
        size="sm"
      />
      <View style={styles.content}>
        <Text style={styles.actionLine} numberOfLines={1}>
          <Text style={styles.username}>{user.display_name || user.username}</Text>
          {' '}
          <Text style={styles.action}>{ACTION_TEXT[type] ?? type}</Text>
          {'  '}
          <Text style={styles.time}>{getRelativeTime(timestamp)}</Text>
        </Text>
        {type !== 'follows' && cast?.text ? (
          <Text style={styles.preview} numberOfLines={2}>
            {cast.text}
          </Text>
        ) : null}
      </View>
      {type !== 'follows' && cast?.hash && onLike && (
        <Pressable
          onPress={() => onLike(cast.hash, cast.viewer_context?.liked ?? false)}
          style={styles.likeButton}
          hitSlop={8}
          accessibilityLabel={cast.viewer_context?.liked ? 'Unlike' : 'Like'}
        >
          <Ionicons
            name={cast.viewer_context?.liked ? 'heart' : 'heart-outline'}
            size={18}
            color={cast.viewer_context?.liked ? colors.error : colors.text.secondary}
          />
        </Pressable>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: colors.background.main,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
    gap: 12,
  },
  unread: {
    backgroundColor: colors.background.surface,
  },
  content: {
    flex: 1,
    gap: 2,
  },
  actionLine: {
    fontSize: typography.size.body,
    color: colors.text.body,
  },
  username: {
    fontWeight: '600',
    color: colors.text.primary,
  },
  action: {
    color: colors.text.secondary,
  },
  time: {
    color: colors.text.placeholder,
    fontSize: typography.size.sm,
  },
  preview: {
    color: colors.text.secondary,
    fontSize: typography.size.body2,
    lineHeight: 18,
  },
  likeButton: {
    padding: 8,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
