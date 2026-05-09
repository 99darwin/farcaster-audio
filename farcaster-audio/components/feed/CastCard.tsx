import { useState, useCallback, useMemo, memo } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  FlatList,
  useWindowDimensions,
  ActionSheetIOS,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import Toast from "react-native-toast-message";
import { Avatar } from "@/components/common/Avatar";
import { CastActions } from "@/components/feed/CastActions";
import { CastText } from "@/components/feed/CastText";
import { SelectableCastText } from "@/components/feed/SelectableCastText";
import { OgPreview } from "@/components/feed/OgPreview";
import { MediaViewer } from "@/components/common/ImageViewer";
import { VideoPlayer } from "@/components/feed/VideoPlayer";
import { touchTarget } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { getUserByUsername } from "@/services/api";
import { haptic } from "@/utils/haptics";
import type { NeynarCast, NeynarChannel, NeynarEmbed } from "@/types/neynar";

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
  hideThreadLine?: boolean;
}

function getRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

function isImageUrl(embed: NeynarEmbed): boolean {
  const contentType = embed.metadata?.content_type ?? "";
  if (contentType.startsWith("image/")) return true;
  // Neynar populates image dimensions for image embeds even without content_type
  if (embed.metadata?.image?.width_px) return true;
  const url = embed.url ?? "";
  return /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url);
}

function isVideoUrl(embed: NeynarEmbed): boolean {
  const contentType = embed.metadata?.content_type ?? "";
  if (contentType.startsWith("video/")) return true;
  const url = embed.url ?? "";
  return /\.(mp4|mov|m3u8|webm)(\?|$)/i.test(url);
}

function EmbedImage({
  uri,
  style,
  onPress,
}: {
  uri: string;
  style: any;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [hasError, setHasError] = useState(false);

  if (hasError) {
    return (
      <Pressable onPress={onPress}>
        <View style={[style, styles.imageFallback]}>
          <Ionicons
            name="image-outline"
            size={32}
            color={colors.text.secondary}
          />
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable onPress={onPress}>
      <Image
        source={{ uri }}
        style={style}
        contentFit="cover"
        transition={200}
        onError={() => setHasError(true)}
      />
    </Pressable>
  );
}

function CastImages({
  embeds,
  onImagePress,
}: {
  embeds: NeynarEmbed[];
  onImagePress: (images: string[], index: number) => void;
}) {
  const images = useMemo(
    () => embeds.filter((e) => e.url && !e.cast && isImageUrl(e)),
    [embeds],
  );
  const imageUrls = useMemo(() => images.map((e) => e.url!), [images]);
  const styles = useStyles();
  const [activeIndex, setActiveIndex] = useState(0);
  const { width: screenWidth } = useWindowDimensions();
  // Account for container padding (16) + avatar (40) + gap (12) + right padding (16)
  const carouselWidth = screenWidth - 16 - 40 - 12 - 16;

  if (images.length === 0) return null;

  if (images.length === 1) {
    const img = images[0];
    const meta = img.metadata?.image;
    const aspectRatio =
      meta?.width_px && meta?.height_px
        ? meta.width_px / meta.height_px
        : 16 / 9;
    return (
      <View style={styles.imageContainer}>
        <EmbedImage
          uri={img.url!}
          style={[styles.singleImage, { aspectRatio }]}
          onPress={() => onImagePress(imageUrls, 0)}
        />
      </View>
    );
  }

  return (
    <View style={styles.imageContainer}>
      <FlatList
        data={images.slice(0, 4)}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(e) => {
          const index = Math.round(
            e.nativeEvent.contentOffset.x / carouselWidth,
          );
          setActiveIndex(index);
        }}
        keyExtractor={(item) => item.url!}
        renderItem={({ item, index }) => (
          <EmbedImage
            uri={item.url!}
            style={{ width: carouselWidth, aspectRatio: 4 / 3 }}
            onPress={() => onImagePress(imageUrls, index)}
          />
        )}
      />
      <View style={styles.dotRow}>
        {images.slice(0, 4).map((_, i) => (
          <View
            key={i}
            style={[
              styles.carouselDot,
              i === activeIndex && styles.carouselDotActive,
            ]}
          />
        ))}
      </View>
    </View>
  );
}

function CastVideos({ embeds }: { embeds: NeynarEmbed[] }) {
  const videos = useMemo(
    () => embeds.filter((e) => e.url && !e.cast && isVideoUrl(e)),
    [embeds],
  );
  if (videos.length === 0) return null;

  const video = videos[0];
  const ogImages = video.metadata?.html?.ogImage;
  const thumbnailUrl = ogImages?.[0]?.url ?? undefined;
  const meta = video.metadata?.image;
  const aspectRatio =
    meta?.width_px && meta?.height_px ? meta.width_px / meta.height_px : 16 / 9;

  return (
    <VideoPlayer
      url={video.url!}
      thumbnailUrl={thumbnailUrl}
      aspectRatio={aspectRatio}
    />
  );
}

function ChannelAttribution({ channel }: { channel: NeynarChannel }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const label = `/${channel.id}`;

  return (
    <Pressable
      style={styles.channelChip}
      onPress={() => router.push(`/channel/${channel.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`View channel ${label}`}
    >
      {channel.image_url ? (
        <Image
          source={{ uri: channel.image_url }}
          style={styles.channelAvatar}
          contentFit="cover"
        />
      ) : (
        <Ionicons name="albums-outline" size={13} color={colors.purple} />
      )}
      <Text style={styles.channelChipText} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

function QuoteCast({
  cast,
  onPress,
}: {
  cast: NeynarCast;
  onPress?: () => void;
}) {
  const styles = useStyles();
  if (!cast?.author) return null;
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
        <CastText
          text={cast.text}
          style={styles.quoteText}
          numberOfLines={3}
          selectable
        />
      ) : null}
      {cast.embeds && cast.embeds.length > 0 ? (
        <CastImages
          embeds={cast.embeds}
          onImagePress={() => {
            /* noop in quotes */
          }}
        />
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
  hiddenUrls,
  granularSelection,
}: {
  text: string;
  expanded?: boolean;
  onMentionPress?: (username: string) => void;
  hiddenUrls?: Set<string>;
  granularSelection?: boolean;
}) {
  const styles = useStyles();
  const [isExpanded, setIsExpanded] = useState(false);
  const shouldTruncate =
    !expanded && !isExpanded && text.length > TRUNCATE_LENGTH;
  const displayText = shouldTruncate ? text.slice(0, TRUNCATE_LENGTH) : text;

  if (granularSelection) {
    return (
      <View style={styles.bodyContainer}>
        <SelectableCastText
          text={displayText}
          style={styles.text}
          hiddenUrls={hiddenUrls}
          onMentionPress={onMentionPress}
        />
      </View>
    );
  }

  return (
    <View style={styles.bodyContainer}>
      <CastText
        text={displayText}
        style={styles.text}
        onMentionPress={onMentionPress}
        hiddenUrls={hiddenUrls}
      />
      {shouldTruncate ? (
        <Text style={styles.readMore} onPress={() => setIsExpanded(true)}>
          {"... "}read more
        </Text>
      ) : null}
    </View>
  );
}

function CastCardImpl({
  cast,
  myFid,
  onLike,
  onRecast,
  onQuoteCast,
  onReply,
  onPress,
  expanded,
  threaded,
  hideThreadLine,
}: CastCardProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const isLiked = useMemo(
    () =>
      cast.viewer_context?.liked ??
      cast.reactions.likes.some((l) => l.fid === myFid),
    [cast.reactions.likes, cast.viewer_context?.liked, myFid],
  );
  const isRecasted = useMemo(
    () =>
      cast.viewer_context?.recasted ??
      cast.reactions.recasts.some((r) => r.fid === myFid),
    [cast.reactions.recasts, cast.viewer_context?.recasted, myFid],
  );
  const truncatedText = useMemo(
    () => (cast.text.length > 80 ? `${cast.text.slice(0, 80)}...` : cast.text),
    [cast.text],
  );

  const embeds = useMemo(() => cast.embeds ?? [], [cast.embeds]);
  const quoteCast = useMemo(() => embeds.find((e) => e.cast)?.cast, [embeds]);
  const channel = cast.channel?.id ? cast.channel : null;

  // Collect URLs that will render as OG preview cards so we can hide them from cast text
  const renderedEmbedUrls = useMemo(
    () =>
      new Set(
        embeds
          .filter((e) => {
            if (!e.url || e.cast || isImageUrl(e) || isVideoUrl(e)) {
              return false;
            }
            // X/Twitter always renders a card (even without OG data)
            const domain = e.url.match(
              /^https?:\/\/(?:www\.)?(x\.com|twitter\.com)/,
            );
            if (domain) return true;
            const html = e.metadata?.html;
            const frame = e.metadata?.fc_frame ?? (e.metadata as any)?.frame;
            const hasImage = !!(frame?.image_url || html?.ogImage?.[0]?.url);
            const hasTitle = !!html?.ogTitle;
            const hasDescription = !!html?.ogDescription;
            return hasImage || hasTitle || hasDescription;
          })
          .map((e) => e.url!),
      ),
    [embeds],
  );
  const ogEmbeds = useMemo(
    () => embeds.filter((e) => e.url && !e.cast && !isImageUrl(e) && !isVideoUrl(e)),
    [embeds],
  );

  const [viewerState, setViewerState] = useState<{
    images: string[];
    index: number;
  } | null>(null);

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

  const handleCopyText = useCallback(async () => {
    const text = cast.text.trim();
    if (!text) return;

    haptic.selection();
    await Clipboard.setStringAsync(text);
    Toast.show({
      type: "success",
      text1: "Cast text copied",
    });
  }, [cast.text]);

  const handleCastMenuPress = useCallback(() => {
    haptic.selection();
    const hasText = cast.text.trim().length > 0;

    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: ["Cancel", "Copy text"],
        cancelButtonIndex: 0,
        disabledButtonIndices: hasText ? [] : [1],
      },
      (buttonIndex) => {
        if (buttonIndex === 1) {
          handleCopyText();
        }
      },
    );
  }, [cast.text, handleCopyText]);

  const card = (
    <View
      style={[styles.container, threaded && styles.threadedContainer]}
      accessibilityRole="summary"
      accessibilityLabel={`${cast.author.display_name}: ${truncatedText}`}
    >
      {threaded && !hideThreadLine && <View style={styles.threadLine} />}
      <Pressable onPress={() => navigateToProfile(cast.author.fid)}>
        <Avatar
          pfpUrl={cast.author.pfp_url}
          displayName={cast.author.display_name}
          size={threaded ? "sm" : "md"}
        />
      </Pressable>
      <View style={styles.content}>
        <View style={styles.headerRow}>
          <Pressable
            style={styles.header}
            onPress={() => navigateToProfile(cast.author.fid)}
          >
            <Text style={styles.displayName} numberOfLines={1}>
              {cast.author.display_name}
            </Text>
            <Text style={styles.username} numberOfLines={1}>
              @{cast.author.username}
            </Text>
            {cast.author.pro?.status === "subscribed" && (
              <Ionicons
                name="checkmark-circle"
                size={14}
                color={colors.purple}
              />
            )}
            <Text style={styles.dot}>{"\u00B7"}</Text>
            <Text style={styles.timestamp}>
              {getRelativeTime(cast.timestamp)}
            </Text>
          </Pressable>
          {channel ? <ChannelAttribution channel={channel} /> : null}
          <Pressable
            style={styles.menuButton}
            hitSlop={8}
            onPress={handleCastMenuPress}
            accessibilityRole="button"
            accessibilityLabel="Cast options"
          >
            <Ionicons
              name="ellipsis-horizontal"
              size={18}
              color={colors.text.secondary}
            />
          </Pressable>
        </View>
        {expanded ? (
          <CastBody
            text={cast.text}
            expanded={expanded}
            onMentionPress={handleMentionPress}
            hiddenUrls={renderedEmbedUrls}
            granularSelection
          />
        ) : (
          <Pressable onPress={onPress} disabled={!onPress}>
            <CastBody
              text={cast.text}
              expanded={expanded}
              onMentionPress={handleMentionPress}
              hiddenUrls={renderedEmbedUrls}
            />
          </Pressable>
        )}
        <CastImages
          embeds={embeds}
          onImagePress={(images, index) => setViewerState({ images, index })}
        />
        <CastVideos embeds={embeds} />
        {ogEmbeds.map((embed) => (
            <OgPreview
              key={embed.url}
              embed={embed}
              castContext={{
                hash: cast.hash,
                authorFid: cast.author.fid,
                authorUsername: cast.author.username,
                text: cast.text,
              }}
            />
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
          authorUsername={cast.author.username}
          castHash={cast.hash}
        />
      </View>
      <MediaViewer
        images={viewerState?.images ?? []}
        initialIndex={viewerState?.index ?? 0}
        visible={viewerState !== null}
        onClose={() => setViewerState(null)}
      />
    </View>
  );

  return card;
}

export const CastCard = memo(CastCardImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row" as const,
      padding: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
      gap: 12,
    },
    content: {
      flex: 1,
    },
    headerRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      marginBottom: 4,
    },
    menuButton: {
      width: 32,
      minHeight: touchTarget.min,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      marginVertical: -8,
      marginRight: -8,
    },
    header: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
    },
    displayName: {
      color: colors.text.primary,
      fontWeight: "600" as const,
      fontSize: 15,
      flexShrink: 1,
    },
    username: {
      color: colors.text.secondary,
      fontSize: 14,
      flexShrink: 1,
    },
    bodyContainer: {
      marginTop: 0,
    },
    dot: {
      color: colors.text.secondary,
      fontSize: 14,
    },
    timestamp: {
      color: colors.text.secondary,
      fontSize: 14,
    },
    channelChip: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      maxWidth: 112,
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.purple,
      backgroundColor: "rgba(139, 92, 246, 0.12)",
    },
    channelAvatar: {
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: colors.background.subtle,
    },
    channelChipText: {
      color: colors.text.primary,
      fontSize: 12,
      fontWeight: "600" as const,
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
      overflow: "hidden" as const,
    },
    singleImage: {
      width: "100%" as const,
      borderRadius: 12,
    },
    dotRow: {
      flexDirection: "row" as const,
      justifyContent: "center" as const,
      gap: 5,
      marginTop: 8,
    },
    carouselDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.text.secondary,
      opacity: 0.4,
    },
    carouselDotActive: {
      opacity: 1,
      backgroundColor: colors.purple,
    },
    imageFallback: {
      backgroundColor: colors.background.border,
      justifyContent: "center" as const,
      alignItems: "center" as const,
    },
    // Threaded reply styles
    threadedContainer: {
      paddingLeft: 52,
    },
    threadLine: {
      position: "absolute" as const,
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
      flexDirection: "row" as const,
      alignItems: "center" as const,
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
      fontWeight: "600" as const,
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
  }));
