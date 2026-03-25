import { useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Avatar } from '@/components/common/Avatar';
import { CastActions } from '@/components/feed/CastActions';
import { CastText } from '@/components/feed/CastText';
import { OgPreview } from '@/components/feed/OgPreview';
import { ImageViewer } from '@/components/common/ImageViewer';
import { colors } from '@/constants/theme';
import { getUserByUsername } from '@/services/api';
import type { NeynarCast, NeynarEmbed } from '@/types/neynar';

const TRUNCATE_LENGTH = 280;

interface CastCardProps {
  cast: NeynarCast;
  myFid: number;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onQuoteCast: (cast: NeynarCast) => void;
  onReply: (cast: NeynarCast) => void;
  onPress?: () => void;
  expanded?: boolean;
  threaded?: boolean;
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

function CastImages({
  embeds,
  onImagePress,
}: {
  embeds: NeynarEmbed[];
  onImagePress: (uri: string) => void;
}) {
  const images = embeds.filter((e) => e.url && !e.cast && isImageUrl(e));
  if (images.length === 0) return null;

  if (images.length === 1) {
    const img = images[0];
    const meta = img.metadata?.image;
    const aspectRatio = meta?.width_px && meta?.height_px ? meta.width_px / meta.height_px : 16 / 9;
    return (
      <View style={styles.imageContainer}>
        <Pressable onPress={() => onImagePress(img.url!)}>
          <Image
            source={{ uri: img.url }}
            style={[styles.singleImage, { aspectRatio }]}
            contentFit="cover"
            transition={200}
          />
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.imageGrid}>
      {images.slice(0, 4).map((img, i) => (
        <Pressable key={img.url ?? i} onPress={() => onImagePress(img.url!)}>
          <Image
            source={{ uri: img.url }}
            style={styles.gridImage}
            contentFit="cover"
            transition={200}
          />
        </Pressable>
      ))}
    </View>
  );
}

function QuoteCast({ cast, onPress }: { cast: NeynarCast; onPress?: () => void }) {
  const content = (
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
        <CastText text={cast.text} style={styles.quoteText} numberOfLines={3} />
      ) : null}
      {cast.embeds && cast.embeds.length > 0 ? (
        <CastImages embeds={cast.embeds} onImagePress={() => {}} />
      ) : null}
    </View>
  );

  if (onPress) {
    return <Pressable onPress={onPress}>{content}</Pressable>;
  }
  return content;
}

function CastBody({
  text,
  expanded,
  onMentionPress,
}: {
  text: string;
  expanded?: boolean;
  onMentionPress?: (username: string) => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const shouldTruncate = !expanded && !isExpanded && text.length > TRUNCATE_LENGTH;
  const displayText = shouldTruncate ? text.slice(0, TRUNCATE_LENGTH) : text;

  return (
    <Text>
      <CastText text={displayText} style={styles.text} onMentionPress={onMentionPress} />
      {shouldTruncate ? (
        <Text
          style={styles.readMore}
          onPress={() => setIsExpanded(true)}
        >
          {'... '}read more
        </Text>
      ) : null}
    </Text>
  );
}

export function CastCard({
  cast,
  myFid,
  onLike,
  onRecast,
  onQuoteCast,
  onReply,
  onPress,
  expanded,
  threaded,
}: CastCardProps) {
  const router = useRouter();
  const isLiked = cast.viewer_context?.liked ?? cast.reactions.likes.some((l) => l.fid === myFid);
  const isRecasted = cast.viewer_context?.recasted ?? cast.reactions.recasts.some((r) => r.fid === myFid);
  const truncatedText = cast.text.length > 80 ? `${cast.text.slice(0, 80)}...` : cast.text;

  const embeds = cast.embeds ?? [];
  const quoteCast = embeds.find((e) => e.cast)?.cast;

  const [viewerImage, setViewerImage] = useState<string | null>(null);

  const navigateToProfile = useCallback(
    (fid: number) => router.push(`/profile/${fid}`),
    [router],
  );

  const handleMentionPress = useCallback(
    async (username: string) => {
      try {
        const data = await getUserByUsername(username);
        const fid = data?.user?.fid;
        if (fid) navigateToProfile(fid);
      } catch {}
    },
    [navigateToProfile],
  );

  const card = (
    <View
      style={[styles.container, threaded && styles.threadedContainer]}
      accessibilityRole="summary"
      accessibilityLabel={`${cast.author.display_name}: ${truncatedText}`}
    >
      {threaded && <View style={styles.threadLine} />}
      <Pressable onPress={() => navigateToProfile(cast.author.fid)}>
        <Avatar
          pfpUrl={cast.author.pfp_url}
          displayName={cast.author.display_name}
          size={threaded ? 'sm' : 'md'}
        />
      </Pressable>
      <View style={styles.content}>
        <Pressable style={styles.header} onPress={() => navigateToProfile(cast.author.fid)}>
          <Text style={styles.displayName} numberOfLines={1}>
            {cast.author.display_name}
          </Text>
          <Text style={styles.username}>@{cast.author.username}</Text>
          {cast.author.pro?.status === 'subscribed' && (
            <Ionicons name="checkmark-circle" size={14} color={colors.purple} />
          )}
          <Text style={styles.dot}>{'\u00B7'}</Text>
          <Text style={styles.timestamp}>{getRelativeTime(cast.timestamp)}</Text>
        </Pressable>
        <CastBody text={cast.text} expanded={expanded} onMentionPress={handleMentionPress} />
        <CastImages embeds={embeds} onImagePress={setViewerImage} />
        {embeds
          .filter((e) => e.url && !e.cast && !isImageUrl(e))
          .map((embed) => (
            <OgPreview key={embed.url} embed={embed} />
          ))}
        {quoteCast ? (
          <QuoteCast
            cast={quoteCast}
            onPress={() => router.push(`/cast/${quoteCast.hash}`)}
          />
        ) : null}
        <CastActions
          likesCount={cast.reactions.likes_count}
          recastsCount={cast.reactions.recasts_count}
          repliesCount={cast.replies.count}
          isLiked={isLiked}
          isRecasted={isRecasted}
          onLike={() => onLike(cast.hash, isLiked)}
          onRecast={() => onRecast(cast.hash, isRecasted)}
          onQuoteCast={() => onQuoteCast(cast)}
          onReply={() => onReply(cast)}
        />
      </View>
      <ImageViewer uri={viewerImage} onClose={() => setViewerImage(null)} />
    </View>
  );

  if (onPress) {
    return <Pressable onPress={onPress}>{card}</Pressable>;
  }

  return card;
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
  readMore: {
    color: colors.purple,
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
  // Threaded reply styles
  threadedContainer: {
    paddingLeft: 52,
  },
  threadLine: {
    position: 'absolute',
    left: 35,
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: colors.background.border,
  },
  // Quote cast styles
  quoteContainer: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.background.border,
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
    color: colors.text.primary,
    fontWeight: '600',
    fontSize: 13,
    flexShrink: 1,
  },
  quoteUsername: {
    color: colors.text.secondary,
    fontSize: 13,
  },
  quoteText: {
    color: colors.text.body,
    fontSize: 14,
    lineHeight: 19,
  },
});
