import { useEffect, useCallback } from 'react';
import { View, FlatList, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useNotifications } from '@/hooks/useNotifications';
import { NotificationItem } from '@/components/notifications/NotificationItem';
import { getLastSeenNotificationTimestamp } from '@/services/storage';
import { colors, typography } from '@/constants/theme';
import type { NeynarNotification } from '@/types/neynar';
import { useState } from 'react';

export default function NotificationsScreen() {
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
  } = useNotifications();

  const [lastSeenTs, setLastSeenTs] = useState<string | null>(null);

  useEffect(() => {
    fetch();
    getLastSeenNotificationTimestamp().then(setLastSeenTs);
  }, [fetch]);

  useFocusEffect(
    useCallback(() => {
      markAsRead();
    }, [markAsRead]),
  );

  const isUnread = (notification: NeynarNotification) => {
    if (!lastSeenTs) return true;
    return new Date(notification.timestamp).getTime() > new Date(lastSeenTs).getTime();
  };

  const renderItem = useCallback(
    ({ item }: { item: NeynarNotification }) => (
      <NotificationItem
        notification={item}
        isUnread={isUnread(item)}
        onLike={handleLike}
      />
    ),
    [lastSeenTs, handleLike],
  );

  const renderFooter = () => {
    if (!hasMore || !isLoading) return null;
    return (
      <View style={styles.footer}>
        <ActivityIndicator color={colors.text.secondary} />
      </View>
    );
  };

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
        keyExtractor={(item, index) => item.hash ?? `${item.type}-${index}`}
        renderItem={renderItem}
        onEndReached={fetchMore}
        onEndReachedThreshold={0.3}
        onRefresh={refresh}
        refreshing={isRefreshing}
        ListFooterComponent={renderFooter}
        ListEmptyComponent={
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No notifications yet</Text>
          </View>
        }
        contentContainerStyle={notifications.length === 0 ? styles.emptyContainer : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
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
});
