import { useEffect, useState, useCallback } from 'react';
import { FlatList, View, Text, Pressable, StyleSheet, RefreshControl } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/authStore';
import { useCastThread } from '@/hooks/useCastThread';
import { CastCard } from '@/components/feed/CastCard';
import { ComposeModal } from '@/components/feed/ComposeModal';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ErrorView } from '@/components/common/ErrorView';
import { colors } from '@/constants/theme';
import { likeCast, recastCast, removeLike, removeRecast, publishCast } from '@/services/neynar';
import type { NeynarCast } from '@/types/neynar';

export default function CastThreadScreen() {
  const { hash } = useLocalSearchParams<{ hash: string }>();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const myFid = user?.fid ?? 0;
  const { rootCast, replies, isLoading, error, fetch } = useCastThread(hash!, myFid);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [composeVisible, setComposeVisible] = useState(false);
  const [replyTo, setReplyTo] = useState<NeynarCast | null>(null);

  useEffect(() => {
    fetch();
  }, [fetch]);

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
    setComposeVisible(true);
  }, []);

  const handlePublish = useCallback(
    async (text: string, parentHash?: string) => {
      await publishCast(text, parentHash);
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
      <FlatList
        data={replies}
        keyExtractor={(item) => item.hash}
        ListHeaderComponent={
          rootCast ? (
            <CastCard
              cast={rootCast}
              myFid={myFid}
              onLike={handleLike}
              onRecast={handleRecast}
              onReply={handleReply}
              expanded
            />
          ) : null
        }
        renderItem={({ item }) => (
          <CastCard
            cast={item}
            myFid={myFid}
            onLike={handleLike}
            onRecast={handleRecast}
            onReply={handleReply}
            onPress={() => handleCastPress(item.hash)}
            threaded
          />
        )}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.accent}
          />
        }
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
        }}
        onPublish={handlePublish}
        replyTo={replyTo}
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
