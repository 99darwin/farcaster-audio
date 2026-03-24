import { View, Text, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Avatar } from '@/components/common/Avatar';
import { CastActions } from '@/components/feed/CastActions';
import type { NeynarCast, NeynarEmbed } from '@/types/neynar';

interface CastCardProps {
  cast: NeynarCast;
  myFid: number;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
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

function isImageUrl(embed: NeynarEmbed): boolean {
  const contentType = embed.metadata?.content_type ?? '';
  if (contentType.startsWith('image/')) return true;
  const url = embed.url ?? '';
  return /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url);
}

function CastImages({ embeds }: { embeds: NeynarEmbed[] }) {
  const images = embeds.filter((e) => e.url && !e.cast && isImageUrl(e));
  if (images.length === 0) return null;

  if (images.length === 1) {
    const img = images[0];
    const meta = img.metadata?.image;
    const aspectRatio = meta?.width_px && meta?.height_px ? meta.width_px / meta.height_px : 16 / 9;
    return (
      <View style={styles.imageContainer}>
        <Image
          source={{ uri: img.url }}
          style={[styles.singleImage, { aspectRatio }]}
          contentFit="cover"
          transition={200}
        />
      </View>
    );
  }

  return (
    <View style={styles.imageGrid}>
      {images.slice(0, 4).map((img, i) => (
        <Image
          key={img.url ?? i}
          source={{ uri: img.url }}
          style={styles.gridImage}
          contentFit="cover"
          transition={200}
        />
      ))}
    </View>
  );
}

function QuoteCast({ cast }: { cast: NeynarCast }) {
  return (
    <View style={styles.quoteContainer}>
      <View style={styles.quoteHeader}>
        {cast.author.pfp_url ? (
          <Image
            source={{ uri: cast.author.pfp_url }}
            style={styles.quoteAvatar}
            contentFit="cover"
          />
        ) : null}
        <Text style={styles.quoteDisplayName} numberOfLines={1}>
          {cast.author.display_name}
        </Text>
        <Text style={styles.quoteUsername}>@{cast.author.username}</Text>
      </View>
      {cast.text ? (
        <Text style={styles.quoteText} numberOfLines={3}>
          {cast.text}
        </Text>
      ) : null}
      {cast.embeds && cast.embeds.length > 0 ? (
        <CastImages embeds={cast.embeds} />
      ) : null}
    </View>
  );
}

export function CastCard({ cast, myFid, onLike, onRecast }: CastCardProps) {
  const isLiked = cast.viewer_context?.liked ?? cast.reactions.likes.some((l) => l.fid === myFid);
  const isRecasted = cast.viewer_context?.recasted ?? cast.reactions.recasts.some((r) => r.fid === myFid);
  const truncatedText = cast.text.length > 80 ? `${cast.text.slice(0, 80)}...` : cast.text;

  const embeds = cast.embeds ?? [];
  const quoteCast = embeds.find((e) => e.cast)?.cast;

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
        <CastImages embeds={embeds} />
        {quoteCast ? <QuoteCast cast={quoteCast} /> : null}
        <CastActions
          likesCount={cast.reactions.likes_count}
          recastsCount={cast.reactions.recasts_count}
          repliesCount={cast.replies.count}
          isLiked={isLiked}
          isRecasted={isRecasted}
          onLike={() => onLike(cast.hash, isLiked)}
          onRecast={() => onRecast(cast.hash, isRecasted)}
          onReply={() => {}}
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
    borderBottomColor: '#2a2a4a',
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
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 15,
    flexShrink: 1,
  },
  username: {
    color: '#8888aa',
    fontSize: 14,
  },
  dot: {
    color: '#8888aa',
    fontSize: 14,
  },
  timestamp: {
    color: '#8888aa',
    fontSize: 14,
  },
  text: {
    color: '#e0e0e0',
    fontSize: 15,
    lineHeight: 21,
  },
  // Image styles
  imageContainer: {
    marginTop: 8,
    borderRadius: 12,
    overflow: 'hidden',
  },
  singleImage: {
    width: '100%',
    borderRadius: 12,
  },
  imageGrid: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 2,
    borderRadius: 12,
    overflow: 'hidden',
  },
  gridImage: {
    width: '49%',
    aspectRatio: 1,
  },
  // Quote cast styles
  quoteContainer: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#2a2a4a',
    borderRadius: 12,
    padding: 12,
  },
  quoteHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  quoteAvatar: {
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  quoteDisplayName: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 13,
    flexShrink: 1,
  },
  quoteUsername: {
    color: '#8888aa',
    fontSize: 13,
  },
  quoteText: {
    color: '#c0c0d0',
    fontSize: 14,
    lineHeight: 19,
  },
});
