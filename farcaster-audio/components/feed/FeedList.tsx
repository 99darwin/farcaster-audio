import { useEffect, useRef, useCallback, forwardRef } from "react";
import {
  Animated,
  FlatList,
  RefreshControl,
  View,
  Text,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useRouter } from "expo-router";
import { CastCard } from "@/components/feed/CastCard";
import { conversationParent } from "@/utils/castUpdates";
import { VoiceNoteFeedItem } from "@/components/voice-notes/VoiceNoteFeedItem";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { ErrorView } from "@/components/common/ErrorView";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { FarcasterCast } from "@/types/farcaster";
import type { FeedItem } from "@/types/voiceNote";

function SkeletonCard() {
  const skeletonStyles = useSkeletonStyles();
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.7,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <View style={skeletonStyles.container}>
      <Animated.View style={[skeletonStyles.avatar, { opacity }]} />
      <View style={skeletonStyles.content}>
        <Animated.View style={[skeletonStyles.nameLine, { opacity }]} />
        <Animated.View style={[skeletonStyles.textLine, { opacity }]} />
        <Animated.View style={[skeletonStyles.textLineShort, { opacity }]} />
      </View>
    </View>
  );
}

const useSkeletonStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row" as const,
      padding: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
      gap: 12,
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.background.subtle,
    },
    content: {
      flex: 1,
      gap: 8,
    },
    nameLine: {
      width: 120,
      height: 14,
      borderRadius: 4,
      backgroundColor: colors.background.subtle,
    },
    textLine: {
      width: "100%" as const,
      height: 12,
      borderRadius: 4,
      backgroundColor: colors.background.subtle,
    },
    textLineShort: {
      width: "60%" as const,
      height: 12,
      borderRadius: 4,
      backgroundColor: colors.background.subtle,
    },
  }));

interface FeedListProps {
  items: FeedItem[];
  myFid: number;
  isLoading: boolean;
  isRefreshing: boolean;
  hasMore: boolean;
  onRefresh: () => void;
  onEndReached: () => void;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onBookmark: (hash: string, isBookmarked: boolean) => void;
  onQuoteCast: (cast: FarcasterCast) => void;
  onReply: (cast: FarcasterCast) => void;
  onBlockAuthor?: (fid: number) => Promise<void> | void;
  onVoiceNoteLike?: (id: string, isLiked: boolean) => void;
  onVoiceNoteRecast?: (id: string, isRecasted: boolean) => void;
  onVoiceNoteDelete?: (id: string) => void;
  ListHeaderComponent?: React.ReactElement | null;
  emptyTitle?: string;
  emptySubtitle?: string;
  error?: string | null;
  onRetry?: () => void;
  /**
   * Keeps the final row reachable beneath an overlaid control without
   * shrinking the list viewport (for example, the floating tab bar).
   */
  contentContainerStyle?: StyleProp<ViewStyle>;
}

export const FeedList = forwardRef<FlatList, FeedListProps>(function FeedList(
  {
    items,
    myFid,
    isLoading,
    isRefreshing,
    hasMore,
    onRefresh,
    onEndReached,
    onLike,
    onRecast,
    onBookmark,
    onQuoteCast,
    onReply,
    onBlockAuthor,
    onVoiceNoteLike,
    onVoiceNoteRecast,
    onVoiceNoteDelete,
    ListHeaderComponent,
    emptyTitle = "Nothing here yet",
    emptySubtitle = "Follow people to see their posts here",
    error,
    onRetry,
    contentContainerStyle,
  },
  ref,
) {
  const { colors } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const endReachedLockedRef = useRef(false);
  const handleCastPress = useCallback(
    (hash: string) => router.push(`/cast/${hash}`),
    [router],
  );

  const noopLike = useCallback((_id: string, _isLiked: boolean) => {}, []);
  const noopRecast = useCallback((_id: string, _isRecasted: boolean) => {}, []);
  const stableVoiceNoteLike = onVoiceNoteLike ?? noopLike;
  const stableVoiceNoteRecast = onVoiceNoteRecast ?? noopRecast;

  const handleEndReached = useCallback(() => {
    if (endReachedLockedRef.current || isLoading || !hasMore || items.length === 0) {
      return;
    }
    endReachedLockedRef.current = true;
    onEndReached();
  }, [hasMore, isLoading, items.length, onEndReached]);

  useEffect(() => {
    if (!isLoading) {
      endReachedLockedRef.current = false;
    }
  }, [isLoading, items.length]);

  const renderItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      if (item.type === "voice_note") {
        return (
          <VoiceNoteFeedItem
            item={item.data}
            onLike={stableVoiceNoteLike}
            onRecast={stableVoiceNoteRecast}
            onDelete={onVoiceNoteDelete}
          />
        );
      }
      const cast = item.data;
      const parent = conversationParent(cast);
      const cardProps = {
        myFid,
        onLike,
        onRecast,
        onBookmark,
        onQuoteCast,
        onReply,
        onBlockAuthor,
      };
      // X-style conversation: the parent post, a connector line, then the
      // reply. Older backends send only a preview, which CastCard inlines.
      return (
        <>
          {parent ? (
            <CastCard
              {...cardProps}
              cast={parent}
              connectBelow
              onPress={() => handleCastPress(parent.hash)}
            />
          ) : null}
          <CastCard
            {...cardProps}
            cast={cast}
            connectAbove={!!parent}
            onPress={() => handleCastPress(cast.hash)}
          />
        </>
      );
    },
    [
      myFid,
      onLike,
      onRecast,
      onBookmark,
      onQuoteCast,
      onReply,
      onBlockAuthor,
      stableVoiceNoteLike,
      stableVoiceNoteRecast,
      onVoiceNoteDelete,
      handleCastPress,
    ],
  );

  if (isLoading && items.length === 0) {
    return (
      <View accessibilityLabel="Loading feed">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </View>
    );
  }

  if (error && items.length === 0) {
    return <ErrorView message={error} onRetry={onRetry} fullScreen />;
  }

  return (
    <FlatList
      ref={ref}
      accessibilityRole="list"
      data={items}
      keyExtractor={(item) =>
        item.type === "cast" ? item.data.hash : `vn-${item.data.voice_note.id}`
      }
      keyboardDismissMode="on-drag"
      renderItem={renderItem}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.5}
      initialNumToRender={8}
      maxToRenderPerBatch={6}
      updateCellsBatchingPeriod={50}
      windowSize={7}
      removeClippedSubviews
      ListHeaderComponent={ListHeaderComponent}
      ListFooterComponent={
        hasMore && items.length > 0 ? (
          <View style={styles.footer}>
            <LoadingSpinner size="small" />
          </View>
        ) : null
      }
      ListEmptyComponent={
        !isLoading ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>{emptyTitle}</Text>
            <Text style={styles.emptySubtext}>{emptySubtitle}</Text>
          </View>
        ) : null
      }
      contentContainerStyle={
        [items.length === 0 && styles.emptyContainer, contentContainerStyle]
      }
    />
  );
});

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    footer: {
      padding: 20,
      alignItems: "center" as const,
    },
    empty: {
      alignItems: "center" as const,
      justifyContent: "center" as const,
      paddingTop: 60,
    },
    emptyText: {
      color: colors.text.primary,
      fontSize: 18,
      fontWeight: "600" as const,
      marginBottom: 8,
    },
    emptySubtext: {
      color: colors.text.secondary,
      fontSize: 14,
    },
    emptyContainer: {
      flexGrow: 1,
    },
  }));
