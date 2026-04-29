import "@/utils/cryptoPolyfill";
import * as Sentry from "@sentry/react-native";
import { registerGlobals } from "@livekit/react-native";
import { useEffect, useRef } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack, useRouter, useSegments } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Linking from "expo-linking";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuthStore } from "@/stores/authStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useMiniAppStore } from "@/stores/miniappStore";
import { usePrefsStore } from "@/stores/prefsStore";
import { SpaceMiniBar } from "@/components/spaces/SpaceMiniBar";
import {
  MiniAppModal,
  MiniAppMiniBar,
} from "@/components/miniapp/MiniAppModal";
import { TAB_BAR_TOTAL_HEIGHT } from "@/components/navigation/GlassTabBar";
import { UpdateBanner } from "@/components/common/UpdateBanner";
import { useOTAUpdate } from "@/hooks/useOTAUpdate";
import { useNotificationBadge } from "@/hooks/useNotificationBadge";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { colors } from "@/constants/theme";
import Toast, { type ToastConfig } from "react-native-toast-message";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { ViewCastToast } from "@/components/common/ViewCastToast";
import * as livekitService from "@/services/livekit";
import * as api from "@/services/api";
import { Config } from "@/constants/config";

// Must be called before any LiveKit Room usage
registerGlobals();

const toastConfig: ToastConfig = {
  viewCast: ({ props }) => <ViewCastToast props={props} />,
};

Sentry.init({
  dsn: Config.SENTRY_DSN,
  environment: __DEV__ ? "development" : "production",
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
  const { isUpdateAvailable, isRestarting, applyUpdate, dismiss } =
    useOTAUpdate();
  const hydrateAddedMiniApps = useMiniAppStore((s) => s.hydrateAddedMiniApps);
  const loadPrefs = usePrefsStore((s) => s.loadPrefs);

  useNotificationBadge();
  usePushNotifications();

  const pendingDeepLink = useRef<string | null>(null);

  useEffect(() => {
    hydrate();
    hydrateAddedMiniApps();
    loadPrefs();
  }, [hydrate, hydrateAddedMiniApps, loadPrefs]);

  useEffect(() => {
    if (isLoading) return;
    const inAuthGroup = segments[0] === "login";
    if (!isAuthenticated && !inAuthGroup) {
      router.replace("/login");
    } else if (isAuthenticated && inAuthGroup) {
      router.replace("/");
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
    const subscription = Linking.addEventListener("url", ({ url }) => {
      handleDeepLink(url);
    });

    // Handle deep link that launched the app
    Linking.getInitialURL().then((url) => {
      if (url) handleDeepLink(url);
    });

    return () => subscription.remove();
  }, []);

  const isValidMiniAppUrl = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return false;
      const host = parsed.hostname.toLowerCase();
      // Reject private/local IPs and hostnames
      if (host === "localhost" || host.endsWith(".local")) return false;
      // IPv4 private/reserved ranges
      if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
      // IPv6 loopback, link-local, private
      if (/^\[?(::1|fe80:|fc00:|fd00:)/.test(host)) return false;
      // Reject bare IPs (require a real domain)
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return false;
      if (host.startsWith("[")) return false;
      // Must have a dot (real domain)
      if (!host.includes(".")) return false;
      return true;
    } catch {
      return false;
    }
  };

  const handleDeepLink = (url: string) => {
    const parsed = Linking.parse(url);
    const path = parsed.path;
    if (!path) return;

    if (!isAuthenticated) {
      pendingDeepLink.current = url;
      return;
    }

    if (path.startsWith("space/")) {
      const roomId = path.replace("space/", "");
      if (roomId) router.push(`/space/${roomId}`);
    } else if (path.startsWith("voice-note/")) {
      const vnId = path.replace("voice-note/", "");
      if (vnId) {
        // Fetch voice note to get cast_hash, then open cast detail
        fetch(`${Config.API_BASE_URL}/v1/voice-notes/${vnId}`)
          .then((res) => res.json())
          .then((data) => {
            const castHash = data?.voice_note?.cast_hash;
            if (castHash) {
              router.push(`/cast/${castHash}`);
            } else {
              // No cast — navigate to author's profile
              const fid = data?.voice_note?.fid;
              if (fid) router.push(`/profile/${fid}`);
            }
          })
          .catch(() => {});
      }
    } else if (path.startsWith("cast/")) {
      const hash = path.replace("cast/", "");
      if (hash) router.push(`/cast/${hash}`);
    } else if (path.startsWith("profile/")) {
      const fid = path.replace("profile/", "");
      if (fid) router.push(`/profile/${fid}`);
    }
    // Parse: juke://miniapp?url={encoded_url}
    if (parsed.path === "miniapp" && parsed.queryParams?.url) {
      const miniAppUrl = parsed.queryParams.url as string;
      // Validate: must be HTTPS, no private IPs
      if (!isValidMiniAppUrl(miniAppUrl)) return;
      if (isAuthenticated) {
        import("@/services/manifest").then(({ resolveMiniApp }) => {
          resolveMiniApp(miniAppUrl).then((resolved) => {
            useMiniAppStore.getState().openMiniApp({
              url: resolved.launchUrl,
              domain: resolved.domain,
              manifest: resolved.manifest,
              config: resolved.config,
              location: { type: "launcher" },
            });
          });
        });
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
            headerBackButtonDisplayMode: "minimal",
            contentStyle: { backgroundColor: colors.background.main },
          }}
        >
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="login" options={{ headerShown: false }} />
          <Stack.Screen
            name="settings"
            options={{ title: "Settings", presentation: "modal" }}
          />
          <Stack.Screen
            name="notification-settings"
            options={{ title: "Notifications", presentation: "modal" }}
          />
          <Stack.Screen
            name="admin"
            options={{ title: "Admin", presentation: "modal" }}
          />
          <Stack.Screen name="cast/[hash]" options={{ title: "Thread" }} />
          <Stack.Screen name="profile/[fid]" options={{ title: "Profile" }} />
          <Stack.Screen
            name="voice-note/[id]"
            options={{ headerShown: false }}
          />
          <Stack.Screen name="space/[id]" options={{ headerShown: false }} />
          <Stack.Screen
            name="space/create"
            options={{ title: "Create Space" }}
          />
        </Stack>
        {isUpdateAvailable && (
          <UpdateBanner
            isRestarting={isRestarting}
            onUpdate={applyUpdate}
            onDismiss={dismiss}
          />
        )}
        {room && segments[0] !== "space" && (
          <SpaceMiniBar
            onToggleMute={handleToggleMute}
            onLeave={handleLeave}
            bottomOffset={
              segments[0] === "(tabs)"
                ? insets.bottom + TAB_BAR_TOTAL_HEIGHT + 16
                : insets.bottom + 8
            }
          />
        )}
        <MiniAppMiniBar
          bottomOffset={
            room && segments[0] !== "space"
              ? (segments[0] === "(tabs)"
                  ? insets.bottom + TAB_BAR_TOTAL_HEIGHT + 16
                  : insets.bottom + 8) + 56
              : segments[0] === "(tabs)"
                ? insets.bottom + TAB_BAR_TOTAL_HEIGHT + 16
                : insets.bottom + 8
          }
        />
        <MiniAppModal />
        <Toast config={toastConfig} position="bottom" bottomOffset={100} />
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
});
