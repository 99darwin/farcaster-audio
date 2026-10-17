import { useState, useCallback, useMemo, memo } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  FlatList,
  useWindowDimensions,
  ActionSheetIOS,
  Alert,
  Platform,
  type TextStyle,
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
import { touchTarget, withAlpha } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { getUserByUsername } from "@/services/api";
import { haptic } from "@/utils/haptics";
import type {
  FarcasterCast,
  FarcasterChannel,
  FarcasterEmbed,
  FarcasterParentCast,
} from "@/types/farcaster";

const TRUNCATE_LENGTH = 280;

interface CastCardProps {
  cast: FarcasterCast;
  myFid: number;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onBookmark: (hash: string, isBookmarked: boolean) => void;
  onQuoteCast: (cast: FarcasterCast) => void;
  onReply: (cast: FarcasterCast) => void;
  onBlockAuthor?: (fid: number) => Promise<void> | void;
  onPress?: () => void;
  expanded?: boolean;
  threaded?: boolean;
  hideThreadLine?: boolean;
  /** Draw the thread line from the card's top edge down to the avatar. */
  connectAbove?: boolean;
  /** Draw the thread line from the avatar down to the next card in the chain. */
  connectBelow?: boolean;
  /**
   * X-style focal layout for the cast a thread page is about: name stacked
   * over @username, larger text, absolute timestamp and a stats row.
   */
  focal?: boolean;
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

function isImageUrl(embed: FarcasterEmbed): boolean {
  const contentType = embed.metadata?.content_type ?? "";
  if (contentType.startsWith("image/")) return true;
  // The API populates image dimensions for image embeds even without
  // content_type
  if (embed.metadata?.image?.width_px) return true;
  const url = embed.url ?? "";
  return /\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url);
}

function isVideoUrl(embed: FarcasterEmbed): boolean {
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
  embeds: FarcasterEmbed[];
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

function CastVideos({ embeds }: { embeds: FarcasterEmbed[] }) {
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

function ChannelAttribution({ channel }: { channel: FarcasterChannel }) {
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
  cast: FarcasterCast;
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

const PARENT_PREVIEW_MAX_LINES = 3;

function ParentCastPreview({
  parent,
  onPress,
}: {
  parent: FarcasterParentCast;
  onPress: () => void;
}) {
  const styles = useStyles();
  const displayName =
    parent.author.display_name || parent.author.username || "Unknown";

  return (
    <Pressable
      style={styles.parentRow}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Replying to ${displayName}: ${parent.text}`}
    >
      <View style={styles.parentRail}>
        <Avatar
          pfpUrl={parent.author.pfp_url ?? null}
          displayName={displayName}
          size="sm"
        />
        <View style={styles.parentConnector} />
      </View>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.parentDisplayName} numberOfLines={1}>
            {displayName}
          </Text>
          {parent.author.username ? (
            <Text style={styles.username} numberOfLines={1}>
              @{parent.author.username}
            </Text>
          ) : null}
          {parent.timestamp ? (
            <>
              <Text style={styles.dot}>{"\u00B7"}</Text>
              <Text style={styles.timestamp}>
                {getRelativeTime(parent.timestamp)}
              </Text>
            </>
          ) : null}
        </View>
        {parent.text ? (
          <CastText
            text={parent.text}
            style={styles.parentText}
            numberOfLines={PARENT_PREVIEW_MAX_LINES}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

function CastBody({
  text,
  expanded,
  onMentionPress,
  hiddenUrls,
  granularSelection,
  textStyle,
}: {
  text: string;
  expanded?: boolean;
  onMentionPress?: (username: string) => void;
  hiddenUrls?: Set<string>;
  granularSelection?: boolean;
  textStyle?: TextStyle;
}) {
  const styles = useStyles();
  const bodyTextStyle = textStyle ?? styles.text;
  const [isExpanded, setIsExpanded] = useState(false);
  const shouldTruncate =
    !expanded && !isExpanded && text.length > TRUNCATE_LENGTH;
  const displayText = shouldTruncate ? text.slice(0, TRUNCATE_LENGTH) : text;

  if (granularSelection) {
    return (
      <View style={styles.bodyContainer}>
        <SelectableCastText
          text={displayText}
          style={bodyTextStyle}
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
        style={bodyTextStyle}
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
  onBookmark,
  onQuoteCast,
  onReply,
  onBlockAuthor,
  onPress,
  expanded,
  threaded,
  hideThreadLine,
  connectAbove,
  connectBelow,
  focal,
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
  const isBookmarked = cast.viewer_context?.bookmarked ?? false;
  const truncatedText = useMemo(
    () => (cast.text.length > 80 ? `${cast.text.slice(0, 80)}...` : cast.text),
    [cast.text],
  );

  const embeds = useMemo(() => cast.embeds ?? [], [cast.embeds]);
  const quoteCast = useMemo(() => embeds.find((e) => e.cast)?.cast, [embeds]);
  const channel = cast.channel?.id ? cast.channel : null;
  // Thread views already render the parent above its replies.
  const isInThread = threaded || focal || connectAbove || connectBelow;
  const parentCast = isInThread ? null : cast.parent_cast;

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
    const canBlock = !!onBlockAuthor && cast.author.fid !== myFid;
    const options = ["Cancel", "Copy text"];
    if (canBlock) {
      options.push(`Block @${cast.author.username}`);
    }
    const blockButtonIndex = canBlock ? options.length - 1 : undefined;

    const onCopy = () => {
      handleCopyText();
    };
    const onBlock = async () => {
      if (!onBlockAuthor) return;
      try {
        await onBlockAuthor(cast.author.fid);
        Toast.show({
          type: "success",
          text1: `Blocked @${cast.author.username}`,
        });
      } catch {
        Toast.show({
          type: "error",
          text1: "Failed to block user",
        });
      }
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options,
          cancelButtonIndex: 0,
          destructiveButtonIndex: blockButtonIndex,
          disabledButtonIndices: hasText ? [] : [1],
        },
        async (buttonIndex) => {
          if (buttonIndex === 1) {
            onCopy();
            return;
          }
          if (buttonIndex === blockButtonIndex) {
            await onBlock();
          }
        },
      );
    } else {
      const buttons: Parameters<typeof Alert.alert>[2] = [
        { text: "Cancel", style: "cancel" },
      ];
      if (hasText) buttons.push({ text: "Copy text", onPress: onCopy });
      if (canBlock) {
        buttons.push({
          text: `Block @${cast.author.username}`,
          style: "destructive",
          onPress: onBlock,
        });
      }
      Alert.alert("", undefined, buttons);
    }
  }, [
    cast.author.fid,
    cast.author.username,
    cast.text,
    handleCopyText,
    myFid,
    onBlockAuthor,
  ]);

  const avatar = (
    <Pressable
      style={styles.avatarPressable}
      onPress={() => navigateToProfile(cast.author.fid)}
    >
      <Avatar
        pfpUrl={cast.author.pfp_url}
        displayName={cast.author.display_name}
        size={threaded ? "sm" : "md"}
      />
    </Pressable>
  );

  const proBadge =
    cast.author.pro?.status === "subscribed" ? (
      <Ionicons name="checkmark-circle" size={14} color={colors.purple} />
    ) : null;

  const headerActions = (
    <>
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
    </>
  );

  const media = (
    <>
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
          onPress={() => router.push(`/cast/${encodeURIComponent(quoteCast.hash)}`)}
        />
      ) : null}
    </>
  );

  const actions = (
    <CastActions
      likesCount={cast.reactions.likes_count}
      recastsCount={cast.reactions.recasts_count}
      repliesCount={cast.replies.count}
      isLiked={isLiked}
      isRecasted={isRecasted}
      isBookmarked={isBookmarked}
      onLike={() => onLike(cast.hash, isLiked)}
      onRecast={() => onRecast(cast.hash, isRecasted)}
      onBookmark={() => onBookmark(cast.hash, isBookmarked)}
      onQuoteCast={() => onQuoteCast(cast)}
      onReply={() => onReply(cast)}
      authorUsername={cast.author.username}
      castHash={cast.hash}
    />
  );

  const mediaViewer = (
    <MediaViewer
      images={viewerState?.images ?? []}
      initialIndex={viewerState?.index ?? 0}
      visible={viewerState !== null}
      onClose={() => setViewerState(null)}
    />
  );

  if (focal) {
    return (
      <View
        style={styles.focalContainer}
        accessibilityLabel={`${cast.author.display_name}: ${truncatedText}`}
        testID="focal-cast"
      >
        {connectAbove && (
          <View style={styles.focalLineAbove} testID="thread-line-above" />
        )}
        <View style={[styles.headerRow, styles.focalHeader]}>
          {avatar}
          <Pressable
            style={styles.focalNameBlock}
            onPress={() => navigateToProfile(cast.author.fid)}
          >
            <View style={styles.authorNameRow}>
              <Text style={styles.focalDisplayName} numberOfLines={1}>
                {cast.author.display_name}
              </Text>
              {proBadge}
            </View>
            <Text style={styles.username} numberOfLines={1}>
              @{cast.author.username}
            </Text>
          </Pressable>
          {headerActions}
        </View>
        <CastBody
          text={cast.text}
          expanded
          onMentionPress={handleMentionPress}
          hiddenUrls={renderedEmbedUrls}
          granularSelection
          textStyle={styles.focalText}
        />
        {media}
        <Text style={styles.focalTimestamp}>
          {formatAbsoluteTime(cast.timestamp)}
        </Text>
        <FocalStats
          replies={cast.replies.count}
          recasts={cast.reactions.recasts_count}
          likes={cast.reactions.likes_count}
        />
        <View style={styles.focalActions}>{actions}</View>
        {mediaViewer}
      </View>
    );
  }

  return (
    <Pressable
      style={[
        styles.container,
        threaded && styles.threadedContainer,
        connectBelow && styles.chainedContainer,
      ]}
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="summary"
      accessibilityLabel={`${cast.author.display_name}: ${truncatedText}`}
    >
      {threaded && !hideThreadLine && <View style={styles.threadLine} />}
      {parentCast ? (
        <ParentCastPreview
          parent={parentCast}
          onPress={() =>
            router.push(`/cast/${encodeURIComponent(parentCast.hash)}`)
          }
        />
      ) : null}
      <View style={styles.row}>
        <View style={styles.avatarColumn}>
          {connectAbove && (
            <View style={styles.lineAbove} testID="thread-line-above" />
          )}
          {avatar}
          {connectBelow && (
            <View style={styles.lineBelow} testID="thread-line-below" />
          )}
        </View>
        <View style={styles.content}>
          <View style={styles.headerRow}>
            <View style={styles.header}>
              <Pressable
                style={styles.authorNameRow}
                onPress={() => navigateToProfile(cast.author.fid)}
              >
                <Text style={styles.displayName} numberOfLines={1}>
                  {cast.author.display_name}
                </Text>
                <Text style={styles.username} numberOfLines={1}>
                  @{cast.author.username}
                </Text>
                {proBadge}
              </Pressable>
              <Text style={styles.dot}>{"\u00B7"}</Text>
              <Text style={styles.timestamp}>
                {getRelativeTime(cast.timestamp)}
              </Text>
            </View>
            {headerActions}
          </View>
          <CastBody
            text={cast.text}
            expanded={expanded}
            onMentionPress={handleMentionPress}
            hiddenUrls={renderedEmbedUrls}
            granularSelection={expanded}
          />
          {media}
          {actions}
        </View>
      </View>
      {mediaViewer}
    </Pressable>
  );
}

/** "3:42 PM · Oct 16, 2026" — X's focal-post timestamp. */
export function formatAbsoluteTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const day = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return `${time} \u00B7 ${day}`;
}

function FocalStats({
  replies,
  recasts,
  likes,
}: {
  replies: number;
  recasts: number;
  likes: number;
}) {
  const styles = useStyles();
  const stats = [
    { count: replies, one: "Reply", many: "Replies" },
    { count: recasts, one: "Recast", many: "Recasts" },
    { count: likes, one: "Like", many: "Likes" },
  ].filter((stat) => stat.count > 0);
  if (stats.length === 0) return null;
  return (
    <View style={styles.focalStats} testID="focal-stats">
      {stats.map((stat) => (
        <Text key={stat.one} style={styles.focalStatLabel}>
          <Text style={styles.focalStatCount}>{stat.count}</Text>{" "}
          {stat.count === 1 ? stat.one : stat.many}
        </Text>
      ))}
    </View>
  );
}

export const CastCard = memo(CastCardImpl);

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      padding: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    row: {
      flexDirection: "row" as const,
      gap: 12,
    },
    content: {
      flex: 1,
    },
    avatarPressable: {
      alignSelf: "flex-start" as const,
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
    authorNameRow: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 4,
      flexShrink: 1,
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
    // Thread chain connectors (X-style): a 2px line centered under the avatar.
    chainedContainer: {
      borderBottomWidth: 0,
    },
    avatarColumn: {
      alignItems: "center" as const,
    },
    lineAbove: {
      position: "absolute" as const,
      top: -16,
      height: 16,
      width: 2,
      backgroundColor: withAlpha(colors.text.secondary, 0.4),
    },
    lineBelow: {
      flex: 1,
      width: 2,
      marginTop: 4,
      marginBottom: -16,
      backgroundColor: withAlpha(colors.text.secondary, 0.4),
    },
    // Parent cast preview styles (reply context in feeds)
    parentRow: {
      flexDirection: "row" as const,
      gap: 12,
    },
    parentRail: {
      width: 48,
      alignItems: "center" as const,
    },
    parentConnector: {
      flex: 1,
      width: 2,
      minHeight: 8,
      marginVertical: 4,
      borderRadius: 1,
      backgroundColor: colors.background.border,
    },
    parentDisplayName: {
      color: colors.text.primary,
      fontWeight: "600" as const,
      fontSize: 14,
      flexShrink: 1,
    },
    parentText: {
      color: colors.text.secondary,
      fontSize: 14,
      lineHeight: 19,
      marginBottom: 12,
    },
    // Focal (thread subject) styles
    focalContainer: {
      paddingHorizontal: 16,
      paddingTop: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    focalLineAbove: {
      position: "absolute" as const,
      left: 16 + 24 - 1,
      top: 0,
      height: 12,
      width: 2,
      backgroundColor: withAlpha(colors.text.secondary, 0.4),
    },
    focalHeader: {
      marginBottom: 12,
    },
    focalNameBlock: {
      flex: 1,
      minWidth: 0,
    },
    focalDisplayName: {
      color: colors.text.primary,
      fontWeight: "700" as const,
      fontSize: 16,
      flexShrink: 1,
    },
    focalText: {
      color: colors.text.primary,
      fontSize: 17,
      lineHeight: 24,
    },
    focalTimestamp: {
      color: colors.text.secondary,
      fontSize: 15,
      marginTop: 12,
      marginBottom: 12,
    },
    focalStats: {
      flexDirection: "row" as const,
      flexWrap: "wrap" as const,
      gap: 16,
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.background.border,
    },
    focalStatLabel: {
      color: colors.text.secondary,
      fontSize: 15,
    },
    focalStatCount: {
      color: colors.text.primary,
      fontWeight: "700" as const,
    },
    focalActions: {
      paddingVertical: 4,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.background.border,
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
