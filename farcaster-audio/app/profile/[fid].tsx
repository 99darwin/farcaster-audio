import { useEffect, useCallback, useMemo, useState } from 'react';
import { FlatList, View, Text, StyleSheet, RefreshControl } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/authStore';
import { useProfile } from '@/hooks/useProfile';
import { ProfileHeader, type ProfileTab } from '@/components/profile/ProfileHeader';
import { CastCard } from '@/components/feed/CastCard';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { ErrorView } from '@/components/common/ErrorView';
import { colors } from '@/constants/theme';
import { ComposeModal } from '@/components/feed/ComposeModal';
import { likeCast, recastCast, removeLike, removeRecast, publishCast } from '@/services/neynar';
import type { NeynarCast } from '@/types/neynar';

export default function ProfileScreen() {
  const { fid: fidParam } = useLocalSearchParams<{ fid: string }>();
  const fid = Number(fidParam);
  const router = useRouter();
  const myFid = useAuthStore((s) => s.user?.fid) ?? 0;
  const isOwnProfile = fid === myFid;

  const [activeTab, setActiveTab] = useState<ProfileTab>('casts');
  const [composeVisible, setComposeVisible] = useState(false);
  const [quoteCastTarget, setQuoteCastTarget] = useState<NeynarCast | null>(null);

  const {
    user,
    casts,
    isLoading,
    isCastsLoading,
    hasMoreCasts,
    error,
    fetchProfile,
    fetchMoreCasts,
    toggleFollow,
  } = useProfile(fid);

  const filteredCasts = useMemo(
    () =>
      activeTab === 'casts'
        ? casts.filter((c) => !c.parent_hash)
        : casts.filter((c) => !!c.parent_hash),
    [casts, activeTab],
  );

  useEffect(() => {
    fetchProfile();
  }, [fetchProfile]);

  const handleLike = useCallback(
    async (castHash: string, isLiked: boolean) => {
      try {
        if (isLiked) await removeLike(castHash);
        else await likeCast(castHash);
        await fetchProfile();
      } catch {}
    },
    [fetchProfile],
  );

  const handleRecast = useCallback(
    async (castHash: string, isRecasted: boolean) => {
      try {
        if (isRecasted) await removeRecast(castHash);
        else await recastCast(castHash);
        await fetchProfile();
      } catch {}
    },
    [fetchProfile],
  );

  const handleReply = useCallback(
    (_cast: NeynarCast) => {
      router.push(`/cast/${_cast.hash}`);
    },
    [router],
  );

  const handleQuoteCast = useCallback((cast: NeynarCast) => {
    setQuoteCastTarget(cast);
    setComposeVisible(true);
  }, []);

  const handlePublish = useCallback(
    async (text: string, _parentHash?: string, imageUris?: string[], quote?: { fid: number; hash: string }) => {
      await publishCast(text, undefined, imageUris && imageUris.length > 0 ? imageUris : undefined, quote);
      await fetchProfile();
    },
    [fetchProfile],
  );

  const handleCastPress = useCallback(
    (castHash: string) => {
      router.push(`/cast/${castHash}`);
    },
    [router],
  );

  if (isLoading && !user) {
    return <LoadingSpinner fullScreen />;
  }

  if (error && !user) {
    return <ErrorView message={error} onRetry={fetchProfile} fullScreen />;
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={filteredCasts}
        keyExtractor={(item) => item.hash}
        ListHeaderComponent={
          user ? (
            <ProfileHeader
              user={user}
              isOwnProfile={isOwnProfile}
              onFollowToggle={toggleFollow}
              activeTab={activeTab}
              onTabChange={setActiveTab}
            />
          ) : null
        }
        renderItem={({ item }) => (
          <CastCard
            cast={item}
            myFid={myFid}
            onLike={handleLike}
            onRecast={handleRecast}
            onQuoteCast={handleQuoteCast}
            onReply={handleReply}
            onPress={() => handleCastPress(item.hash)}
          />
        )}
        onEndReached={fetchMoreCasts}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={fetchProfile}
            tintColor={colors.accent}
          />
        }
        ListFooterComponent={
          isCastsLoading && casts.length > 0 ? (
            <View style={styles.footer}>
              <LoadingSpinner size="small" />
            </View>
          ) : null
        }
        ListEmptyComponent={
          !isLoading ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {activeTab === 'casts' ? 'No casts yet' : 'No replies yet'}
              </Text>
            </View>
          ) : null
        }
      />
      <ComposeModal
        isVisible={composeVisible}
        onClose={() => {
          setComposeVisible(false);
          setQuoteCastTarget(null);
        }}
        onPublish={handlePublish}
        quoteCast={quoteCastTarget}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  footer: {
    padding: 20,
    alignItems: 'center',
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
