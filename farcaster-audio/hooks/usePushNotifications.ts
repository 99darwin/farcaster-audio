import { useCallback, useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { useAuthStore } from "@/stores/authStore";
import * as api from "@/services/api";
import * as storage from "@/services/storage";
import { getNotificationRoute } from "@/utils/notificationRouting";

const PROJECT_ID = "YOUR_EAS_PROJECT_ID";

// Show notifications when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export function usePushNotifications() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const router = useRouter();
  const notificationResponseListener = useRef<Notifications.Subscription>(null);
  const registeredRef = useRef(false);
  const handledNotificationRef = useRef<string | null>(null);

  const handleNotificationResponse = useCallback(
    (response: Notifications.NotificationResponse | null | undefined) => {
      if (!response) return;
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) {
        return;
      }

      const request = response.notification.request;
      const route = getNotificationRoute(request.content.data);
      if (!route) return;

      const dedupeKey = `${request.identifier}:${route}`;
      if (handledNotificationRef.current === dedupeKey) return;
      handledNotificationRef.current = dedupeKey;
      router.push(route as any);
      Notifications.clearLastNotificationResponse();
    },
    [router],
  );

  useEffect(() => {
    if (!isAuthenticated) {
      registeredRef.current = false;
      return;
    }

    if (!registeredRef.current) {
      registerForPushNotifications();
    }

    // Handle notification taps
    notificationResponseListener.current =
      Notifications.addNotificationResponseReceivedListener(
        handleNotificationResponse,
      );

    handleNotificationResponse(Notifications.getLastNotificationResponse());

    return () => {
      notificationResponseListener.current?.remove();
    };
  }, [handleNotificationResponse, isAuthenticated]);

  async function registerForPushNotifications() {
    if (!Device.isDevice) {
      if (__DEV__) console.log("[Push] Skipping — not a physical device");
      return;
    }

    if (Platform.OS !== "ios") return;

    // Check existing token to avoid redundant registration
    const existingToken = await storage.getPushToken();

    const { status: existingStatus } =
      await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== "granted") {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== "granted") {
      if (__DEV__) console.log("[Push] Permission not granted");
      return;
    }

    try {
      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId: PROJECT_ID,
      });
      const token = tokenData.data;

      // Always register with backend (upserts + syncs webhook filters)
      await api.registerPushToken({ expo_push_token: token });
      await storage.savePushToken(token);
      registeredRef.current = true;
      if (__DEV__) console.log("[Push] Registered token:", token);
    } catch (error) {
      if (__DEV__) console.error("[Push] Failed to register:", error);
    }
  }
}

export async function unregisterPushToken() {
  try {
    const token = await storage.getPushToken();
    if (token) {
      await api.unregisterPushToken({ expo_push_token: token });
      await storage.clearPushToken();
    }
  } catch (error) {
    if (__DEV__) console.error("[Push] Failed to unregister:", error);
  }
}
