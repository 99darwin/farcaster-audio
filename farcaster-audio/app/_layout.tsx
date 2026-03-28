import * as Sentry from '@sentry/react-native';
import { registerGlobals } from '@livekit/react-native';
import { useEffect, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuthStore } from '@/stores/authStore';
import { useSpaceStore } from '@/stores/spaceStore';
import { SpaceMiniBar } from '@/components/spaces/SpaceMiniBar';
import { TAB_BAR_TOTAL_HEIGHT } from '@/components/navigation/GlassTabBar';
import { UpdateBanner } from '@/components/common/UpdateBanner';
import { useOTAUpdate } from '@/hooks/useOTAUpdate';
import { useNotificationBadge } from '@/hooks/useNotificationBadge';
import { colors } from '@/constants/theme';
import Toast from 'react-native-toast-message';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import * as livekitService from '@/services/livekit';
import * as api from '@/services/api';
import { Config } from '@/constants/config';

// Must be called before any LiveKit Room usage
registerGlobals();

Sentry.init({
  dsn: Config.SENTRY_DSN,
  environment: __DEV__ ? 'development' : 'production',
  enabled: !__DEV__,
  tracesSampleRate: 0.1,
});

export default function RootLayout() {
  const { isAuthenticated, isLoading, hydrate } = useAuthStore();
  const insets = useSafeAreaInsets();
  const room = useSpaceStore((s) => s.room);
  const leaveSpace = useSpaceStore((s) => s.leaveSpace);
  const setMuted = useSpaceStore((s) => s.setMuted);
  const router = useRouter();
  const segments = useSegments();
  const { isUpdateAvailable, isRestarting, applyUpdate, dismiss } = useOTAUpdate();

  useNotificationBadge();

  const pendingDeepLink = useRef<string | null>(null);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (isLoading) return;
    const inAuthGroup = segments[0] === 'login';
    if (!isAuthenticated && !inAuthGroup) {
      router.replace('/login');
    } else if (isAuthenticated && inAuthGroup) {
      router.replace('/');
      // Process any deep link that arrived before auth completed
      if (pendingDeepLink.current) {
        const url = pendingDeepLink.current;
        pendingDeepLink.current = null;
        handleDeepLink(url);
      }
    }
  }, [isAuthenticated, isLoading, segments, router]);

  useEffect(() => {
    // Handle deep links when app is already open
    const subscription = Linking.addEventListener('url', ({ url }) => {
      handleDeepLink(url);
    });

    // Handle deep link that launched the app
    Linking.getInitialURL().then((url) => {
      if (url) handleDeepLink(url);
    });

    return () => subscription.remove();
  }, []);

  const handleDeepLink = (url: string) => {
    // Parse: juke://space/{id} or https://juke.audio/space/{id}
    const parsed = Linking.parse(url);
    if (parsed.path?.startsWith('space/')) {
      const roomId = parsed.path.replace('space/', '');
      if (!roomId) return;
      if (isAuthenticated) {
        router.push(`/space/${roomId}`);
      } else {
        pendingDeepLink.current = url;
      }
    }
  };

  const handleToggleMute = async () => {
    const isMuted = await livekitService.toggleMicrophone();
    setMuted(isMuted);
  };

  const handleLeave = async () => {
    if (room) {
      try {
        await api.leaveRoom(room.id);
      } catch {}
      await livekitService.disconnectFromRoom();
      leaveSpace();
    }
  };

  if (isLoading) {
    return <LoadingSpinner fullScreen />;
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <GestureHandlerRootView style={styles.container}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background.surface },
            headerTintColor: colors.text.primary,
            headerBackButtonDisplayMode: 'minimal',
            contentStyle: { backgroundColor: colors.background.main },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="settings" options={{ title: 'Settings', presentation: 'modal' }} />
          <Stack.Screen name="admin" options={{ title: 'Admin', presentation: 'modal' }} />
          <Stack.Screen name="cast/[hash]" options={{ title: 'Thread' }} />
          <Stack.Screen name="profile/[fid]" options={{ title: 'Profile' }} />
          <Stack.Screen name="space/[id]" options={{ title: 'Space' }} />
          <Stack.Screen name="space/create" options={{ title: 'Create Space' }} />
        </Stack>
        {isUpdateAvailable && (
          <UpdateBanner
            isRestarting={isRestarting}
            onUpdate={applyUpdate}
            onDismiss={dismiss}
          />
        )}
        {room && segments[0] !== 'space' && (
          <SpaceMiniBar
            onToggleMute={handleToggleMute}
            onLeave={handleLeave}
            bottomOffset={segments[0] === '(tabs)' ? insets.bottom + TAB_BAR_TOTAL_HEIGHT + 16 : insets.bottom + 8}
          />
        )}
        <Toast />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
