import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuthStore } from "@/stores/authStore";
import { useComposeStore } from "@/stores/composeStore";
import { useChannelFeed } from "@/hooks/useChannelFeed";
import { FeedList } from "@/components/feed/FeedList";
import { ComposeModal } from "@/components/feed/ComposeModal";
import { GlassView } from "@/components/common/GlassView";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { NeynarCast } from "@/types/neynar";

export default function ChannelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { colors, glass } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  const channelId = Array.isArray(id) ? id[0] : id;
  const normalizedChannelId = channelId ?? "";
  const {
    items,
    isLoading,
    isRefreshing,
    hasMore,
    error,
    fetch,
    fetchMore,
    refresh,
    handleLike,
    handleRecast,
    handleBookmark,
    handleBlockAuthor,
    handlePublishCast,
  } = useChannelFeed(normalizedChannelId);
  const [isComposeVisible, setIsComposeVisible] = useState(false);
  const [replyTarget, setReplyTarget] = useState<NeynarCast | null>(null);
  const [quoteCastTarget, setQuoteCastTarget] = useState<NeynarCast | null>(
    null,
  );
  const composeDraft = useComposeStore((s) => s.draft);
  const clearDraft = useComposeStore((s) => s.clearDraft);

  useEffect(() => {
    fetch();
  }, [fetch]);

  const openReply = useCallback((cast: NeynarCast) => {
    setReplyTarget(cast);
    setQuoteCastTarget(null);
    setIsComposeVisible(true);
  }, []);

  const openQuoteCast = useCallback((cast: NeynarCast) => {
    setQuoteCastTarget(cast);
    setReplyTarget(null);
    setIsComposeVisible(true);
  }, []);

  const closeCompose = useCallback(() => {
    setIsComposeVisible(false);
    setReplyTarget(null);
    setQuoteCastTarget(null);
    clearDraft();
  }, [clearDraft]);

  const openChannelCompose = useCallback(() => {
    setReplyTarget(null);
    setQuoteCastTarget(null);
    setIsComposeVisible(true);
  }, []);

  const header = useMemo(
    () => (
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityLabel="Go back"
          accessibilityRole="button"
          style={styles.backButton}
        >
          <Ionicons name="chevron-back" size={24} color={colors.text.primary} />
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.eyebrow}>Channel</Text>
          <Text style={styles.title} numberOfLines={1}>
            /{normalizedChannelId}
          </Text>
        </View>
      </View>
    ),
    [colors.text.primary, insets.top, normalizedChannelId, router, styles],
  );

  return (
    <View style={styles.container}>
      <FeedList
        items={items}
        myFid={user?.fid ?? 0}
        isLoading={isLoading}
        isRefreshing={isRefreshing}
        hasMore={hasMore}
        onRefresh={refresh}
        onEndReached={fetchMore}
        onLike={handleLike}
        onRecast={handleRecast}
        onBookmark={handleBookmark}
        onQuoteCast={openQuoteCast}
        onReply={openReply}
        onBlockAuthor={handleBlockAuthor}
        ListHeaderComponent={header}
        error={error}
        onRetry={fetch}
      />

      <GlassView
        style={[
          styles.floatingComposeButton,
          { bottom: insets.bottom + 24 },
        ]}
        overlayColor={glass.accentOverlay}
      >
        <Pressable
          onPress={openChannelCompose}
          accessibilityRole="button"
          accessibilityLabel={`Cast to ${normalizedChannelId}`}
          style={styles.floatingComposeTouchTarget}
        >
          <Ionicons
            name="create-outline"
            size={24}
            color={colors.text.primary}
          />
        </Pressable>
      </GlassView>

      <ComposeModal
        isVisible={isComposeVisible}
        onClose={closeCompose}
        onPublish={handlePublishCast}
        onPublishComplete={refresh}
        replyTo={replyTarget}
        quoteCast={quoteCastTarget}
        defaultText={composeDraft?.text}
        defaultEmbeds={composeDraft?.embeds}
        initialChannelId={
          replyTarget
            ? undefined
            : composeDraft?.channelId ?? normalizedChannelId
        }
      />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingHorizontal: 16,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    backButton: {
      width: 36,
      height: 36,
      alignItems: "center",
      justifyContent: "center",
    },
    headerText: {
      flex: 1,
    },
    eyebrow: {
      color: colors.text.secondary,
      fontSize: 12,
      textTransform: "uppercase" as const,
      fontWeight: "700" as const,
    },
    title: {
      color: colors.text.primary,
      fontSize: 22,
      fontWeight: "700" as const,
    },
    floatingComposeButton: {
      position: "absolute",
      right: 20,
      width: 56,
      height: 56,
      borderRadius: 28,
    },
    floatingComposeTouchTarget: {
      width: 56,
      height: 56,
      alignItems: "center",
      justifyContent: "center",
    },
  }));
