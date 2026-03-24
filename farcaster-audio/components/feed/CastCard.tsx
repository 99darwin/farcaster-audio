import { View, Text, StyleSheet } from 'react-native';
import { Avatar } from '@/components/common/Avatar';
import { CastActions } from '@/components/feed/CastActions';
import { colors } from '@/constants/theme';
import type { NeynarCast } from '@/types/neynar';

interface CastCardProps {
  cast: NeynarCast;
  myFid: number;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onReply: (cast: NeynarCast) => void;
}

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

export function CastCard({ cast, myFid, onLike, onRecast, onReply }: CastCardProps) {
  const isLiked = cast.reactions.likes.some((l) => l.fid === myFid);
  const isRecasted = cast.reactions.recasts.some((r) => r.fid === myFid);
  const truncatedText = cast.text.length > 80 ? `${cast.text.slice(0, 80)}...` : cast.text;

  return (
    <View
      style={styles.container}
      accessibilityRole="summary"
      accessibilityLabel={`${cast.author.display_name}: ${truncatedText}`}
    >
      <Avatar
        pfpUrl={cast.author.pfp_url}
        displayName={cast.author.display_name}
        size="md"
      />
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.displayName} numberOfLines={1}>
            {cast.author.display_name}
          </Text>
          <Text style={styles.username}>@{cast.author.username}</Text>
          <Text style={styles.dot}>{'\u00B7'}</Text>
          <Text style={styles.timestamp}>{getRelativeTime(cast.timestamp)}</Text>
        </View>
        <Text style={styles.text}>{cast.text}</Text>
        <CastActions
          likesCount={cast.reactions.likes_count}
          recastsCount={cast.reactions.recasts_count}
          repliesCount={cast.replies.count}
          isLiked={isLiked}
          isRecasted={isRecasted}
          onLike={() => onLike(cast.hash, isLiked)}
          onRecast={() => onRecast(cast.hash, isRecasted)}
          onReply={() => onReply(cast)}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
    gap: 12,
  },
  content: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginBottom: 4,
  },
  displayName: {
    color: colors.text.primary,
    fontWeight: '600',
    fontSize: 15,
    flexShrink: 1,
  },
  username: {
    color: colors.text.secondary,
    fontSize: 14,
  },
  dot: {
    color: colors.text.secondary,
    fontSize: 14,
  },
  timestamp: {
    color: colors.text.secondary,
    fontSize: 14,
  },
  text: {
    color: colors.text.body,
    fontSize: 15,
    lineHeight: 21,
  },
});
