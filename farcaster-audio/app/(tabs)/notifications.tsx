import { useEffect, useCallback, useRef, useState } from "react";
import { View, FlatList, Text, ActivityIndicator } from "react-native";
import { useNavigation } from "expo-router";
import { useNotifications } from "@/hooks/useNotifications";
import { useNotificationStore } from "@/stores/notificationStore";
import { NotificationItem } from "@/components/notifications/NotificationItem";
import { ComposeModal } from "@/components/feed/ComposeModal";
import { getLastSeenNotificationTimestamp } from "@/services/storage";
import { typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { NeynarCast, NeynarNotification } from "@/types/neynar";

export default function NotificationsScreen() {
  const { colors } = useTheme();
  const styles = useStyles();
  const {
    notifications,
    isLoading,
    isRefreshing,
    hasMore,
    fetch,
    fetchMore,
    refresh,
    markAsRead,
    handleLike,
    handleRecast,
    handlePublishCast,
  } = useNotifications();

  const navigation = useNavigation();
  const [lastSeenTs, setLastSeenTs] = useState<string | null>(null);
  const hasFetched = useRef(false);

  const [isComposeVisible, setIsComposeVisible] = useState(false);
  const [replyTarget, setReplyTarget] = useState<NeynarCast | null>(null);
  const [quoteCastTarget, setQuoteCastTarget] = useState<NeynarCast | null>(
    null,
  );

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
  }, []);

  useEffect(() => {
    if (hasFetched.current) return;
    hasFetched.current = true;
    const lastFetchedAt = useNotificationStore.getState().lastFetchedAt;
    const isFresh =
      lastFetchedAt !== null && Date.now() - lastFetchedAt < 60_000;
    if (!isFresh) {
      fetch();
    }
    getLastSeenNotificationTimestamp().then(setLastSeenTs);
  }, []);

  // Mark as read when the tab gains focus
  useEffect(() => {
    const unsubscribe = navigation.addListener("focus", () => {
      markAsRead();
    });
    return unsubscribe;
  }, [navigation, markAsRead]);

  // Also mark as read after initial data load (focus fires before fetch completes)
  const hasNotifications = notifications.length > 0;
  useEffect(() => {
    if (hasNotifications) {
      markAsRead();
    }
  }, [hasNotifications, markAsRead]);

  const isUnread = useCallback(
    (notification: NeynarNotification) => {
      if (!lastSeenTs) return true;
      return (
        new Date(notification.most_recent_timestamp).getTime() >
        new Date(lastSeenTs).getTime()
      );
    },
    [lastSeenTs],
  );

  const renderItem = useCallback(
    ({ item }: { item: NeynarNotification }) => (
      <NotificationItem
        notification={item}
        isUnread={isUnread(item)}
        onLike={handleLike}
        onRecast={handleRecast}
        onReply={openReply}
        onQuoteCast={openQuoteCast}
      />
    ),
    [isUnread, handleLike, handleRecast, openReply, openQuoteCast],
  );

  const handleEndReached = useCallback(() => {
    if (!isLoading) {
      fetchMore();
    }
  }, [isLoading, fetchMore]);

  if (isLoading && notifications.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.text.secondary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={notifications}
        keyExtractor={(item, index) =>
          `${item.type}-${item.most_recent_timestamp}-${index}`
        }
        renderItem={renderItem}
        onEndReached={handleEndReached}
        onEndReachedThreshold={0.3}
        onRefresh={refresh}
        refreshing={isRefreshing}
        ListFooterComponent={
          hasMore && isLoading ? (
            <View style={styles.footer}>
              <ActivityIndicator color={colors.text.secondary} />
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No notifications yet</Text>
          </View>
        }
        contentContainerStyle={
          notifications.length === 0 ? styles.emptyContainer : undefined
        }
      />

      <ComposeModal
        isVisible={isComposeVisible}
        onClose={closeCompose}
        onPublish={handlePublishCast}
        replyTo={replyTarget}
        quoteCast={quoteCastTarget}
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
    centered: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
    },
    emptyContainer: {
      flex: 1,
    },
    footer: {
      paddingVertical: 16,
    },
    emptyText: {
      color: colors.text.secondary,
      fontSize: typography.size.md,
    },
  }));
