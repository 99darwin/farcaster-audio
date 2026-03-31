import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/authStore';
import * as api from '@/services/api';
import * as storage from '@/services/storage';

const PROJECT_ID = 'YOUR_EAS_PROJECT_ID';

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

  useEffect(() => {
    if (!isAuthenticated) return;
    if (registeredRef.current) return;

    registerForPushNotifications();

    // Handle notification taps
    notificationResponseListener.current =
      Notifications.addNotificationResponseReceivedListener((response) => {
        const data = response.notification.request.content.data;
        const url = data?.url as string | undefined;
        if (url) {
          router.push(url as any);
        }
      });

    return () => {
      notificationResponseListener.current?.remove();
    };
  }, [isAuthenticated]);

  async function registerForPushNotifications() {
    if (!Device.isDevice) {
      if (__DEV__) console.log('[Push] Skipping — not a physical device');
      return;
    }

    if (Platform.OS !== 'ios') return;

    // Check existing token to avoid redundant registration
    const existingToken = await storage.getPushToken();

    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      if (__DEV__) console.log('[Push] Permission not granted');
      return;
    }

    try {
      const tokenData = await Notifications.getExpoPushTokenAsync({ projectId: PROJECT_ID });
      const token = tokenData.data;

      // Only register if token changed
      if (token !== existingToken) {
        await api.registerPushToken({ expo_push_token: token });
        await storage.savePushToken(token);
        registeredRef.current = true;
        if (__DEV__) console.log('[Push] Registered token:', token);
      } else {
        registeredRef.current = true;
      }
    } catch (error) {
      if (__DEV__) console.error('[Push] Failed to register:', error);
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
    if (__DEV__) console.error('[Push] Failed to unregister:', error);
  }
}
