import { useCallback } from 'react';
import { Pressable } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/authStore';
import { useComposeStore } from '@/stores/composeStore';
import { Avatar } from '@/components/common/Avatar';
import { GlassTabBar } from '@/components/navigation/GlassTabBar';
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

export default function TabLayout() {
  const requestCompose = useComposeStore((s) => s.requestCompose);
  const handleCompose = useCallback(() => requestCompose(), [requestCompose]);

  return (
    <Tabs
      tabBar={(props) => <GlassTabBar {...props} onCompose={handleCompose} />}
      screenOptions={{
        headerStyle: { backgroundColor: colors.background.surface },
        headerTintColor: colors.text.primary,
        tabBarStyle: { position: 'absolute' },
        headerRight: () => <HeaderAvatar />,
        headerRightContainerStyle: { paddingRight: 16 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: 'Home' }}
      />
      <Tabs.Screen
        name="notifications"
        options={{ title: 'Notifications' }}
      />
    </Tabs>
  );
}
