import { useEffect, useRef, useState, useCallback } from 'react';
import { FlatList, View, Text, RefreshControl, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/authStore';
import { useComposeStore } from '@/stores/composeStore';
import { useCastThread } from '@/hooks/useCastThread';
import { CastCard } from '@/components/feed/CastCard';
import { ThreadedReplies, findTopLevelIndexContaining } from '@/components/feed/ThreadedReplies';
import { ComposeModal } from '@/components/feed/ComposeModal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ErrorView } from '@/components/common/ErrorView';
import { colors } from '@/constants/theme';
import { likeCast, recastCast, removeLike, removeRecast, publishCast } from '@/services/neynar';
import type { NeynarCast, NeynarCastWithReplies } from '@/types/neynar';

export default function CastThreadScreen() {
  const { hash, focusHash } = useLocalSearchParams<{ hash: string; focusHash?: string }>();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const myFid = user?.fid ?? 0;
  const { rootCast, replies, isLoading, error, fetch } = useCastThread(hash!, myFid);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [composeVisible, setComposeVisible] = useState(false);
  const [replyTo, setReplyTo] = useState<NeynarCast | null>(null);
  const [quoteCastTarget, setQuoteCastTarget] = useState<NeynarCast | null>(null);
  const flatListRef = useRef<FlatList<NeynarCastWithReplies>>(null);

  // Listen for compose intents from snap buttons
  const composeSignal = useComposeStore((s) => s.composeSignal);
  const composeDraft = useComposeStore((s) => s.draft);
  const clearDraft = useComposeStore((s) => s.clearDraft);
  const composeSignalRef = useRef(composeSignal);
  useEffect(() => {
    if (composeSignal > composeSignalRef.current) {
      setReplyTo(null);
      setQuoteCastTarget(null);
      setComposeVisible(true);
    }
    composeSignalRef.current = composeSignal;
  }, [composeSignal]);

  useEffect(() => {
    fetch();
  }, [fetch]);

  // Scroll to the focused reply once thread data is loaded.
  useEffect(() => {
    if (!focusHash || replies.length === 0) return;
    if (rootCast?.hash === focusHash) return; // header already visible
    const index = findTopLevelIndexContaining(replies, focusHash);
    if (index < 0) return;
    const raf = requestAnimationFrame(() => {
      flatListRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.2 });
    });
    return () => cancelAnimationFrame(raf);
  }, [focusHash, replies, rootCast?.hash]);

  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; highestMeasuredFrameIndex: number; averageItemLength: number }) => {
      // Reply rows have variable height; retry after a short delay.
      setTimeout(() => {
        flatListRef.current?.scrollToIndex({
          index: info.index,
          animated: true,
          viewPosition: 0.2,
        });
      }, 100);
    },
    [],
  );

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await fetch();
    setIsRefreshing(false);
  }, [fetch]);

  const handleLike = useCallback(
    async (castHash: string, isLiked: boolean) => {
      try {
        if (isLiked) await removeLike(castHash);
        else await likeCast(castHash);
        await fetch();
      } catch {}
    },
    [fetch],
  );

  const handleRecast = useCallback(
    async (castHash: string, isRecasted: boolean) => {
      try {
        if (isRecasted) await removeRecast(castHash);
        else await recastCast(castHash);
        await fetch();
      } catch {}
    },
    [fetch],
  );

  const handleReply = useCallback((cast: NeynarCast) => {
    setReplyTo(cast);
    setQuoteCastTarget(null);
    setComposeVisible(true);
  }, []);

  const handleQuoteCast = useCallback((cast: NeynarCast) => {
    setQuoteCastTarget(cast);
    setReplyTo(null);
    setComposeVisible(true);
  }, []);

  const handlePublish = useCallback(
    async (text: string, parentHash?: string, imageUris?: string[], quote?: { fid: number; hash: string }) => {
      await publishCast(text, parentHash, imageUris && imageUris.length > 0 ? imageUris : undefined, quote);
      await fetch();
    },
    [fetch],
  );

  const handleCastPress = useCallback(
    (castHash: string) => {
      if (castHash !== hash) {
        router.push(`/cast/${castHash}`);
      }
    },
    [hash, router],
  );

  if (isLoading && !rootCast) {
    return <LoadingSpinner fullScreen />;
  }

  if (error && !rootCast) {
    return <ErrorView message={error} onRetry={fetch} fullScreen />;
  }

  return (
    <View style={styles.container}>
      <FlatList<NeynarCastWithReplies>
        ref={flatListRef}
        data={replies}
        keyExtractor={(item) => item.hash}
        onScrollToIndexFailed={handleScrollToIndexFailed}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.accent}
          />
        }
        ListHeaderComponent={
          rootCast ? (
            <CastCard
              cast={rootCast}
              myFid={myFid}
              onLike={handleLike}
              onRecast={handleRecast}
              onQuoteCast={handleQuoteCast}
              onReply={handleReply}
              expanded
            />
          ) : null
        }
        renderItem={({ item }) => (
          <ThreadedReplies
            replies={[item]}
            myFid={myFid}
            onLike={handleLike}
            onRecast={handleRecast}
            onQuoteCast={handleQuoteCast}
            onReply={handleReply}
            onCastPress={handleCastPress}
            focusHash={focusHash}
          />
        )}
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No replies yet</Text>
            </View>
          ) : null
        }
      />
      <ComposeModal
        isVisible={composeVisible}
        onClose={() => {
          setComposeVisible(false);
          setReplyTo(null);
          setQuoteCastTarget(null);
          clearDraft();
        }}
        onPublish={handlePublish}
        replyTo={replyTo}
        quoteCast={quoteCastTarget}
        defaultText={composeDraft?.text}
        defaultEmbeds={composeDraft?.embeds}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  empty: {
    alignItems: 'center',
    paddingTop: 40,
  },
  emptyText: {
    color: colors.text.secondary,
    fontSize: 15,
  },
});
