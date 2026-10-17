import { useEffect, useCallback, useRef, useState } from "react";
import { View, FlatList, Text, ActivityIndicator } from "react-native";
import { useNavigation } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNotifications } from "@/hooks/useNotifications";
import { useAuthStore } from "@/stores/authStore";
import { NotificationItem } from "@/components/notifications/NotificationItem";
import { ComposeModal } from "@/components/feed/ComposeModal";
import { TAB_BAR_CONTENT_INSET } from "@/components/navigation/GlassTabBar";
import { getLastSeenNotificationTimestamp } from "@/services/storage";
import { typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { FarcasterCast, FarcasterNotification } from "@/types/farcaster";

export default function NotificationsScreen() {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const myFid = useAuthStore((s) => s.user?.fid) ?? 0;
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
    handleBookmark,
    handlePublishCast,
  } = useNotifications();

  const navigation = useNavigation();
  const isFocused = useIsFocused();
  const [lastSeenTs, setLastSeenTs] = useState<string | null>(null);
  const listRef = useRef<FlatList<FarcasterNotification>>(null);
  const activationRefreshInFlight = useRef(false);
  const hasOpenedRef = useRef(false);

  const [isComposeVisible, setIsComposeVisible] = useState(false);
  const [replyTarget, setReplyTarget] = useState<FarcasterCast | null>(null);
  const [quoteCastTarget, setQuoteCastTarget] = useState<FarcasterCast | null>(
    null,
  );

  const openReply = useCallback((cast: FarcasterCast) => {
    setReplyTarget(cast);
    setQuoteCastTarget(null);
    setIsComposeVisible(true);
  }, []);

  const openQuoteCast = useCallback((cast: FarcasterCast) => {
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
    getLastSeenNotificationTimestamp().then(setLastSeenTs);
  }, []);

  const refreshFromTabActivation = useCallback(() => {
    // Keep scrolling independent from refresh de-duplication so a quick
    // second tap still takes the user to the beginning of the list.
    listRef.current?.scrollToOffset({ offset: 0, animated: false });

    if (activationRefreshInFlight.current) return;
    activationRefreshInFlight.current = true;
    void refresh().finally(() => {
      activationRefreshInFlight.current = false;
    });
  }, [refresh]);

  const fetchFirstPageSilently = useCallback(() => {
    if (activationRefreshInFlight.current) return;
    activationRefreshInFlight.current = true;
    // `fetch` uses the loading state, not FlatList's `refreshing` state, so
    // first entry never produces the pull-to-refresh overscroll animation.
    void fetch().finally(() => {
      activationRefreshInFlight.current = false;
    });
  }, [fetch]);

  // useIsFocused also covers the initial lazy mount, where a focus listener
  // registered after navigation can miss the event that opened this tab.
  useEffect(() => {
    if (!isFocused) return;
    if (!hasOpenedRef.current) {
      hasOpenedRef.current = true;
      fetchFirstPageSilently();
    } else {
      refreshFromTabActivation();
    }
    markAsRead();
  }, [fetchFirstPageSilently, isFocused, markAsRead, refreshFromTabActivation]);

  // Refresh when the already-focused notifications tab is tapped again.
  useEffect(() => {
    const tabNavigation = navigation as typeof navigation & {
      addListener(type: "tabPress", listener: () => void): () => void;
    };
    const unsubscribe = tabNavigation.addListener("tabPress", () => {
      if (isFocused) {
        refreshFromTabActivation();
      }
    });
    return unsubscribe;
  }, [navigation, isFocused, refreshFromTabActivation]);

  // Also mark as read after initial data load (focus fires before fetch completes)
  const hasNotifications = notifications.length > 0;
  useEffect(() => {
    if (hasNotifications) {
      markAsRead();
    }
  }, [hasNotifications, markAsRead]);

  const isUnread = useCallback(
    (notification: FarcasterNotification) => {
      if (!lastSeenTs) return true;
      return (
        new Date(notification.most_recent_timestamp).getTime() >
        new Date(lastSeenTs).getTime()
      );
    },
    [lastSeenTs],
  );

  const renderItem = useCallback(
    ({ item }: { item: FarcasterNotification }) => (
      <NotificationItem
        notification={item}
        isUnread={isUnread(item)}
        myFid={myFid}
        onLike={handleLike}
        onRecast={handleRecast}
        onBookmark={handleBookmark}
        onReply={openReply}
        onQuoteCast={openQuoteCast}
      />
    ),
    [
      isUnread,
      myFid,
      handleLike,
      handleRecast,
      handleBookmark,
      openReply,
      openQuoteCast,
    ],
  );

  const handleEndReached = useCallback(() => {
    if (!isLoading) {
      fetchMore();
    }
  }, [isLoading, fetchMore]);

  if ((isLoading || isRefreshing) && notifications.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.text.secondary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        ref={listRef}
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
        contentContainerStyle={[
          notifications.length === 0 && styles.emptyContainer,
          { paddingBottom: insets.bottom + TAB_BAR_CONTENT_INSET },
        ]}
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
