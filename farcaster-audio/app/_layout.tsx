import "@/utils/cryptoPolyfill";
import * as Sentry from "@sentry/react-native";
import { registerGlobals } from "@livekit/react-native";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { Platform, StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { Stack, useRouter, useSegments } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Linking from "expo-linking";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { selectIsReadOnly, useAuthStore } from "@/stores/authStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { useMiniAppStore } from "@/stores/miniappStore";
import { usePrefsStore } from "@/stores/prefsStore";
import { SpaceMiniBar } from "@/components/spaces/SpaceMiniBar";
import {
  MiniAppModal,
  MiniAppMiniBar,
} from "@/components/miniapp/MiniAppModal";
import { RelinkBanner } from "@/components/auth/RelinkBanner";
import { TAB_BAR_TOTAL_HEIGHT } from "@/components/navigation/GlassTabBar";
import { UpdateBanner } from "@/components/common/UpdateBanner";
import { useOTAUpdate } from "@/hooks/useOTAUpdate";
import { useNotificationBadge } from "@/hooks/useNotificationBadge";
import { usePushNotifications } from "@/hooks/usePushNotifications";
import { useAuthRefresh } from "@/hooks/useAuthRefresh";
import { useTheme } from "@/hooks/useTheme";
import Toast, { type ToastConfig } from "react-native-toast-message";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { ViewCastToast } from "@/components/common/ViewCastToast";
import * as livekitService from "@/services/livekit";
import * as api from "@/services/api";
import { Config } from "@/constants/config";
import { isValidMiniAppUrl } from "@/utils/url";
import { scrubBreadcrumb, scrubEvent } from "@/utils/sentryScrub";
import { isValidCastHash, parseFid } from "@/utils/farcasterIds";
import { requestConfirmation } from "@/stores/confirmationStore";
import { ConfirmSheet } from "@/components/common/ConfirmSheet";

/**
 * `juke://miniapp?url=` can be fired by any web page or app. Never launch
 * straight into it: resolve the manifest, then make the user tap through a
 * sheet that names the app and its domain.
 */
async function launchDeepLinkedMiniApp(miniAppUrl: string): Promise<void> {
  try {
    const { resolveMiniApp } = await import("@/services/manifest");
    const resolved = await resolveMiniApp(miniAppUrl);
    if (!isValidMiniAppUrl(resolved.launchUrl)) return;
    const appName = resolved.config?.name ?? resolved.domain;
    const isConfirmed = await requestConfirmation({
      title: `Open ${appName}?`,
      message: "A link is asking to open this mini app inside Juke.",
      detail: resolved.domain,
      confirmLabel: "Open mini app",
    });
    if (!isConfirmed) return;
    useMiniAppStore.getState().openMiniApp({
      url: resolved.launchUrl,
      domain: resolved.domain,
      manifest: resolved.manifest,
      config: resolved.config,
      location: { type: "launcher" },
    });
  } catch {
    // Unresolvable manifest: nothing to open.
  }
}

// Must be called before any LiveKit Room usage
registerGlobals();

async function setupAndroidNotificationChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  try {
    await Notifications.setNotificationChannelAsync("default", {
      name: "Default",
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#855DCD",
    });
  } catch (error) {
    if (__DEV__) console.warn("[Notifications] Channel setup failed:", error);
  }
}

const toastConfig: ToastConfig = {
  viewCast: ({ props }) => <ViewCastToast props={props} />,
};

Sentry.init({
  dsn: Config.SENTRY_DSN,
  environment: __DEV__ ? "development" : "production",
  enabled: !__DEV__,
  tracesSampleRate: 0.1,
  // Recovery-phrase hygiene (auth contract §5): no PII, no screenshots or
  // view hierarchies, and every event/breadcrumb is scrubbed.
  sendDefaultPii: false,
  attachScreenshot: false,
  attachViewHierarchy: false,
  beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  beforeSend: (event) => scrubEvent(event),
});

export default function RootLayout() {
  const { isAuthenticated, isLoading, hydrate } = useAuthStore();
  const isReadOnly = useAuthStore(selectIsReadOnly);
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
  const { scheme, colors } = useTheme();

  useNotificationBadge();
  usePushNotifications();
  useAuthRefresh();

  const pendingDeepLink = useRef<string | null>(null);

  useEffect(() => {
    hydrate();
    hydrateAddedMiniApps();
    loadPrefs();
    setupAndroidNotificationChannel();
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

  // Keep a ref to the latest handleDeepLink so the listener registered once
  // on mount always sees current isAuthenticated/router state without
  // re-subscribing on every render.
  const handleDeepLinkRef = useRef<(url: string) => void>(() => {});

  useEffect(() => {
    // Handle deep links when app is already open
    const subscription = Linking.addEventListener("url", ({ url }) => {
      handleDeepLinkRef.current(url);
    });

    // Handle deep link that launched the app
    Linking.getInitialURL().then((url) => {
      if (url) handleDeepLinkRef.current(url);
    });

    return () => subscription.remove();
  }, []);

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
        // Fetch voice note to get cast_hash, then open cast detail. Route
        // through apiClient so the bearer token interceptor attaches, and
        // encode the path segment so an unexpected ID can't traverse to
        // another endpoint.
        api.apiClient
          .get<{
            voice_note?: { cast_hash?: string; fid?: number };
          }>(`/v1/voice-notes/${encodeURIComponent(vnId)}`)
          .then((res) => {
            const castHash = res.data?.voice_note?.cast_hash;
            if (castHash) {
              router.push(`/cast/${castHash}`);
            } else {
              const fid = res.data?.voice_note?.fid;
              if (fid) router.push(`/profile/${fid}`);
            }
          })
          .catch(() => {});
      }
    } else if (path.startsWith("cast/")) {
      const hash = path.replace("cast/", "");
      if (isValidCastHash(hash)) router.push(`/cast/${hash}`);
    } else if (path.startsWith("profile/")) {
      const fid = parseFid(path.replace("profile/", ""));
      if (fid !== null) router.push(`/profile/${fid}`);
    }
    // Parse: juke://miniapp?url={encoded_url}
    if (parsed.path === "miniapp" && parsed.queryParams?.url) {
      const miniAppUrl = parsed.queryParams.url as string;
      // Validate: must be HTTPS, no private IPs
      if (!isValidMiniAppUrl(miniAppUrl)) return;
      if (isAuthenticated) {
        void launchDeepLinkedMiniApp(miniAppUrl);
      } else {
        pendingDeepLink.current = url;
      }
    }
  };

  // Keep the linking subscription's ref pointed at the latest closure so it
  // always reads current isAuthenticated / router state instead of the values
  // captured at first mount.
  useEffect(() => {
    handleDeepLinkRef.current = handleDeepLink;
  });

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
      <StatusBar style={scheme === "light" ? "dark" : "light"} />
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
            name="link-signer"
            options={{ title: "Link Juke", presentation: "modal" }}
          />
          <Stack.Screen
            name="settings"
            options={{ title: "Settings", presentation: "modal" }}
          />
          <Stack.Screen
            name="notification-settings"
            options={{ title: "Notifications", presentation: "modal" }}
          />
          <Stack.Screen
            name="appearance-settings"
            options={{ title: "Appearance", presentation: "modal" }}
          />
          <Stack.Screen
            name="admin"
            options={{ title: "Admin", presentation: "modal" }}
          />
          <Stack.Screen name="search" options={{ headerShown: false }} />
          <Stack.Screen name="bookmarks" options={{ title: "Bookmarks" }} />
          <Stack.Screen
            name="leaderboard"
            options={{ title: "Leaderboard" }}
          />
          <Stack.Screen name="cast/[hash]" options={{ title: "Thread" }} />
          <Stack.Screen name="profile/[fid]" options={{ title: "Profile" }} />
          <Stack.Screen
            name="voice-note/[id]"
            options={{ headerShown: false }}
          />
          <Stack.Screen name="channel/[id]" options={{ headerShown: false }} />
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
        {isReadOnly && segments[0] !== "link-signer" ? (
          <RelinkBanner topOffset={insets.top + 4} />
        ) : null}
        <ConfirmSheet />
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
