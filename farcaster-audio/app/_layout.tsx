import * as Sentry from '@sentry/react-native';
import { registerGlobals } from '@livekit/react-native';
import { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { useAuthStore } from '@/stores/authStore';
import { useSpaceStore } from '@/stores/spaceStore';
import { SpaceMiniBar } from '@/components/spaces/SpaceMiniBar';
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
  const room = useSpaceStore((s) => s.room);
  const leaveSpace = useSpaceStore((s) => s.leaveSpace);
  const setMuted = useSpaceStore((s) => s.setMuted);
  const router = useRouter();
  const segments = useSegments();

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
    // Parse: farcaster-audio://space/{id} or https://farcasteraudio.xyz/space/{id}
    const parsed = Linking.parse(url);
    if (parsed.path?.startsWith('space/')) {
      const roomId = parsed.path.replace('space/', '');
      if (roomId && isAuthenticated) {
        router.push(`/space/${roomId}`);
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
      <View style={styles.container}>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background.surface },
            headerTintColor: colors.text.primary,
            contentStyle: { backgroundColor: colors.background.main },
          }}
        >
          <Stack.Screen name="index" options={{ title: 'Home' }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen name="settings" options={{ title: 'Settings', presentation: 'modal' }} />
          <Stack.Screen name="space/[id]" options={{ title: 'Space' }} />
          <Stack.Screen name="space/create" options={{ title: 'Create Space' }} />
        </Stack>
        {room && (
          <SpaceMiniBar
            onToggleMute={handleToggleMute}
            onLeave={handleLeave}
          />
        )}
        <Toast />
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
