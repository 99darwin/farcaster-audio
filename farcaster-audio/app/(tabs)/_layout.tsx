import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/authStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { Avatar } from '@/components/common/Avatar';
import { colors } from '@/constants/theme';

function HeaderAvatar() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  return (
    <Pressable onPress={() => router.push('/settings')} hitSlop={8} accessibilityLabel="Settings">
      <Avatar
        pfpUrl={user?.pfp_url ?? null}
        displayName={user?.display_name || user?.username || ''}
        size="sm"
      />
    </Pressable>
  );
}

function NotificationIcon({ color, focused }: { color: string; focused: boolean }) {
  const unreadCount = useNotificationStore((s) => s.unreadCount);

  return (
    <View>
      <Ionicons
        name={focused ? 'notifications' : 'notifications-outline'}
        size={24}
        color={color}
      />
      {unreadCount > 0 && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {unreadCount >= 20 ? '20+' : unreadCount}
          </Text>
        </View>
      )}
    </View>
  );
}

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.background.surface },
        headerTintColor: colors.text.primary,
        tabBarStyle: {
          backgroundColor: colors.background.surface,
          borderTopColor: colors.background.border,
        },
        tabBarActiveTintColor: colors.text.primary,
        tabBarInactiveTintColor: colors.text.secondary,
        headerRight: () => <HeaderAvatar />,
        headerRightContainerStyle: { paddingRight: 16 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, focused }) => (
            <Ionicons name={focused ? 'home' : 'home-outline'} size={24} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          title: 'Notifications',
          tabBarIcon: ({ color, focused }) => (
            <NotificationIcon color={color} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    backgroundColor: colors.accent,
    borderRadius: 9,
    minWidth: 18,
    height: 18,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: {
    color: colors.text.primary,
    fontSize: 10,
    fontWeight: '700',
  },
});
