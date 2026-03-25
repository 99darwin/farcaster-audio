import { useEffect, useRef, useCallback } from 'react';
import { Animated, FlatList, RefreshControl, View, Text, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { CastCard } from '@/components/feed/CastCard';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ErrorView } from '@/components/common/ErrorView';
import { colors } from '@/constants/theme';
import type { NeynarCast } from '@/types/neynar';

function SkeletonCard() {
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

const skeletonStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
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
    width: '100%',
    height: 12,
    borderRadius: 4,
    backgroundColor: colors.background.subtle,
  },
  textLineShort: {
    width: '60%',
    height: 12,
    borderRadius: 4,
    backgroundColor: colors.background.subtle,
  },
});

interface FeedListProps {
  casts: NeynarCast[];
  myFid: number;
  isLoading: boolean;
  isRefreshing: boolean;
  hasMore: boolean;
  onRefresh: () => void;
  onEndReached: () => void;
  onLike: (hash: string, isLiked: boolean) => void;
  onRecast: (hash: string, isRecasted: boolean) => void;
  onReply: (cast: NeynarCast) => void;
  ListHeaderComponent?: React.ReactElement | null;
  error?: string | null;
  onRetry?: () => void;
}

export function FeedList({
  casts,
  myFid,
  isLoading,
  isRefreshing,
  hasMore,
  onRefresh,
  onEndReached,
  onLike,
  onRecast,
  onReply,
  ListHeaderComponent,
  error,
  onRetry,
}: FeedListProps) {
  const router = useRouter();
  const handleCastPress = useCallback(
    (hash: string) => router.push(`/cast/${hash}`),
    [router],
  );
  if (isLoading && casts.length === 0) {
    return (
      <View accessibilityLabel="Loading feed">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </View>
    );
  }

  if (error && casts.length === 0) {
    return <ErrorView message={error} onRetry={onRetry} fullScreen />;
  }

  return (
    <FlatList
      accessibilityRole="list"
      data={casts}
      keyExtractor={(item) => item.hash}
      keyboardDismissMode="on-drag"
      renderItem={({ item }) => (
        <CastCard
          cast={item}
          myFid={myFid}
          onLike={onLike}
          onRecast={onRecast}
          onReply={onReply}
          onPress={() => handleCastPress(item.hash)}
        />
      )}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
      onEndReached={onEndReached}
      onEndReachedThreshold={0.5}
      ListHeaderComponent={ListHeaderComponent}
      ListFooterComponent={
        hasMore && casts.length > 0 ? (
          <View style={styles.footer}>
            <LoadingSpinner size="small" />
          </View>
        ) : null
      }
      ListEmptyComponent={
        !isLoading ? (
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No casts yet</Text>
            <Text style={styles.emptySubtext}>Follow people to see their casts here</Text>
          </View>
        ) : null
      }
      contentContainerStyle={casts.length === 0 ? styles.emptyContainer : undefined}
    />
  );
}

const styles = StyleSheet.create({
  footer: {
    padding: 20,
    alignItems: 'center',
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  emptyText: {
    color: colors.text.primary,
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  emptySubtext: {
    color: colors.text.secondary,
    fontSize: 14,
  },
  emptyContainer: {
    flexGrow: 1,
  },
});
