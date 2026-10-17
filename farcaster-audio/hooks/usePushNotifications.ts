import { useCallback, useEffect, useRef } from "react";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import { useRouter } from "expo-router";
import { useAuthStore } from "@/stores/authStore";
import { useSpaceStore } from "@/stores/spaceStore";
import * as api from "@/services/api";
import * as storage from "@/services/storage";
import { getNotificationRoute } from "@/utils/notificationRouting";
import { markSpaceJoinIntent } from "@/utils/spaceJoinIntent";

const PROJECT_ID = process.env.EXPO_PUBLIC_EAS_PROJECT_ID ?? "";

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
  const notificationReceivedListener =
    useRef<Notifications.Subscription | null>(null);
  const registeredRef = useRef(false);
  const handledNotificationRef = useRef<string | null>(null);

  const handleNotificationResponse = useCallback(
    (response: Notifications.NotificationResponse | null | undefined) => {
      if (!response) return;
      if (
        response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER
      ) {
        return;
      }

      const request = response.notification.request;
      const route = getNotificationRoute(request.content.data);
      if (!route) return;

      const dedupeKey = `${request.identifier}:${route}`;
      if (handledNotificationRef.current === dedupeKey) return;
      handledNotificationRef.current = dedupeKey;
      // A tapped Juke notification is an in-app intent, unlike a raw link.
      const spaceRouteMatch = /^\/space\/([^/?#]+)/.exec(route);
      if (spaceRouteMatch) markSpaceJoinIntent(spaceRouteMatch[1]);
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

    // Handle foreground notifications — update store directly for
    // action types that should affect live UI (e.g. hand_raised).
    notificationReceivedListener.current =
      Notifications.addNotificationReceivedListener((notification) => {
        const raw = notification.request.content.data as Record<
          string,
          unknown
        >;
        // Data may be at the top level or nested under a "data" key
        // depending on the push provider / platform.
        const d =
          raw != null && typeof raw === "object" && "data" in raw
            ? (raw.data as Record<string, unknown>)
            : raw;
        if (!d || d.type !== "hand_raised") return;

        const rawFid = d.raiser_fid;
        const rawUrl = d.url;
        if (rawFid == null || typeof rawUrl !== "string") return;

        const raiserFid = Number(rawFid);
        if (!Number.isFinite(raiserFid) || raiserFid <= 0) return;

        // Only update if the user is currently in the referenced room.
        const roomId = rawUrl.replace(/^\/space\//, "");
        const spaceState = useSpaceStore.getState();
        const currentRoom = spaceState.room;
        if (!currentRoom || currentRoom.id !== roomId) return;

        // Only the host renders hand-raise state — skip for all other roles.
        const myFid = useAuthStore.getState().user?.fid;
        if (!myFid || currentRoom.host_fid !== myFid) return;

        // Only flag participants already in the store — prevents a spoofed
        // or replayed push from injecting phantom raised-hand entries.
        if (!spaceState.participants.some((p) => p.fid === raiserFid)) return;

        spaceState.updateParticipant(raiserFid, { hand_raised: true });
      });

    handleNotificationResponse(Notifications.getLastNotificationResponse());

    return () => {
      notificationResponseListener.current?.remove();
      notificationReceivedListener.current?.remove();
    };
  }, [handleNotificationResponse, isAuthenticated]);

  async function registerForPushNotifications() {
    if (!Device.isDevice) {
      if (__DEV__) console.log("[Push] Skipping — not a physical device");
      return;
    }

    if (!PROJECT_ID) {
      if (__DEV__) {
        console.log(
          "[Push] Skipping — EXPO_PUBLIC_EAS_PROJECT_ID not configured",
        );
      }
      return;
    }

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
      if (__DEV__) console.log("[Push] Registered for notifications");
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
