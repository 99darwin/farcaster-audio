import { useRef, useCallback, useMemo } from 'react';
import { Linking } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useWebViewRpcAdapter } from '@farcaster/miniapp-host-react-native';
import type WebView from 'react-native-webview';
import type { MiniAppHost, MiniAppHostCapability, SetPrimaryButtonOptions, MiniAppContext } from '@/types/miniapp';
import { useAuthStore } from '@/stores/authStore';
import { useMiniAppStore } from '@/stores/miniappStore';

// Juke's Farcaster FID — replace with actual value when registered
const JUKE_CLIENT_FID = 0;

const SUPPORTED_CAPABILITIES: MiniAppHostCapability[] = [
  'actions.ready',
  'actions.openUrl',
  'actions.close',
  'actions.setPrimaryButton',
  'actions.addMiniApp',
  'actions.viewCast',
  'actions.viewProfile',
  'actions.composeCast',
  'actions.openMiniApp',
  'haptics.impactOccurred',
  'haptics.notificationOccurred',
  'haptics.selectionChanged',
  'back',
];

interface UseMiniAppHostOptions {
  domain: string;
  launchUrl: string;
  onComposeCast?: (options: {
    text?: string;
    embeds?: string[];
    parentHash?: string;
    channelKey?: string;
  }) => Promise<{ hash: string } | null>;
}

export function useMiniAppHost({ domain, launchUrl, onComposeCast }: UseMiniAppHostOptions) {
  // Cast needed: useWebViewRpcAdapter expects RefObject<WebView> but React 19's useRef(null) yields RefObject<WebView | null>
  const webViewRef = useRef<WebView>(null) as React.RefObject<WebView>;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  const {
    activeMiniApp,
    closeMiniApp,
    hideSplash,
    setPrimaryButton,
    addMiniApp: addToStore,
    isMiniAppAdded,
    openMiniApp: openMiniAppInStore,
  } = useMiniAppStore();

  const isAdded = isMiniAppAdded(domain);

  const context: MiniAppContext = useMemo(() => ({
    client: {
      platformType: 'mobile' as const,
      clientFid: JUKE_CLIENT_FID,
      added: isAdded,
      safeAreaInsets: {
        top: insets.top,
        bottom: insets.bottom,
        left: insets.left,
        right: insets.right,
      },
    },
    // Only share full profile with explicitly added miniapps
    user: isAdded ? {
      fid: user?.fid ?? 0,
      username: user?.username,
      displayName: user?.display_name,
      pfpUrl: user?.pfp_url ?? undefined,
    } : {
      fid: user?.fid ?? 0,
    },
    location: activeMiniApp?.location,
    features: {
      haptics: true,
    },
  }), [domain, user, insets, activeMiniApp?.location, isAdded]);

  const sdk: Omit<MiniAppHost, 'ethProviderRequestV2'> = useMemo(() => ({
    context,

    ready: () => {
      hideSplash();
    },

    close: () => {
      closeMiniApp();
    },

    openUrl: (url: string) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return;
        Linking.openURL(url);
      } catch {
        // Invalid URL — ignore
      }
    },

    setPrimaryButton: (options: SetPrimaryButtonOptions) => {
      setPrimaryButton({
        text: options.text,
        loading: options.loading ?? false,
        disabled: options.disabled ?? false,
        hidden: options.hidden ?? false,
      });
    },

    // --- Social Actions ---

    viewProfile: async ({ fid }: { fid: number }) => {
      if (!Number.isInteger(fid) || fid <= 0) return;
      closeMiniApp();
      router.push(`/profile/${fid}`);
    },

    viewCast: async ({ hash }: { hash: string }) => {
      if (!hash || !/^0x[a-f0-9]+$/i.test(hash)) return;
      closeMiniApp();
      router.push(`/cast/${hash}`);
    },

    composeCast: async <C extends boolean | undefined = undefined>(
      options: { text?: string; embeds?: [] | [string] | [string, string]; parent?: { type: 'cast'; hash: string }; close?: C; channelKey?: string }
    ) => {
      if (options.close) {
        closeMiniApp();
      }

      if (onComposeCast) {
        const result = await onComposeCast({
          text: options.text,
          embeds: options.embeds ? [...options.embeds] : undefined,
          parentHash: options.parent?.hash,
          channelKey: options.channelKey,
        });

        if (options.close) {
          return undefined as any;
        }

        return {
          cast: result ? {
            hash: result.hash,
            text: options.text,
            embeds: options.embeds,
            parent: options.parent,
            channelKey: options.channelKey,
          } : null,
        } as any;
      }

      if (options.close) {
        return undefined as any;
      }
      return { cast: null } as any;
    },

    openMiniApp: async ({ url }: { url: string }) => {
      // Validate URL
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') return;
      } catch {
        return;
      }
      const { resolveMiniApp } = await import('@/services/manifest');
      const resolved = await resolveMiniApp(url);
      closeMiniApp();
      // Small delay to allow modal to dismiss before reopening
      setTimeout(() => {
        openMiniAppInStore({
          url: resolved.launchUrl,
          domain: resolved.domain,
          manifest: resolved.manifest,
          config: resolved.config,
          location: { type: 'open_miniapp', referrerDomain: domain },
        });
      }, 300);
    },

    addMiniApp: async () => {
      const config = activeMiniApp?.config;
      if (!config) {
        return { error: { type: 'invalid_domain_manifest' as const } } as any;
      }
      await addToStore(domain, config);
      return { result: {} } as any;
    },

    // Legacy alias
    addFrame: async () => {
      const config = activeMiniApp?.config;
      if (!config) {
        return { error: { type: 'invalid_domain_manifest' as const } } as any;
      }
      await addToStore(domain, config);
      return { result: {} } as any;
    },

    // --- Haptics ---

    impactOccurred: async (type: 'light' | 'medium' | 'heavy' | 'soft' | 'rigid') => {
      const styleMap: Record<string, Haptics.ImpactFeedbackStyle> = {
        light: Haptics.ImpactFeedbackStyle.Light,
        medium: Haptics.ImpactFeedbackStyle.Medium,
        heavy: Haptics.ImpactFeedbackStyle.Heavy,
        soft: Haptics.ImpactFeedbackStyle.Soft,
        rigid: Haptics.ImpactFeedbackStyle.Rigid,
      };
      await Haptics.impactAsync(styleMap[type] ?? Haptics.ImpactFeedbackStyle.Medium);
    },

    notificationOccurred: async (type: 'success' | 'warning' | 'error') => {
      const typeMap: Record<string, Haptics.NotificationFeedbackType> = {
        success: Haptics.NotificationFeedbackType.Success,
        warning: Haptics.NotificationFeedbackType.Warning,
        error: Haptics.NotificationFeedbackType.Error,
      };
      await Haptics.notificationAsync(typeMap[type] ?? Haptics.NotificationFeedbackType.Success);
    },

    selectionChanged: async () => {
      await Haptics.selectionAsync();
    },

    // --- Capabilities ---

    getCapabilities: async () => SUPPORTED_CAPABILITIES,

    getChains: async () => [],

    // --- Unsupported — return graceful errors so miniapps can degrade ---

    signIn: async () => {
      return { error: { type: 'rejected_by_user' as const } } as any;
    },

    signManifest: async () => {
      return { error: { type: 'rejected_by_user' as const } } as any;
    },

    ethProviderRequest: async () => {
      return { error: { type: 'rejected_by_user' as const } } as any;
    },

    eip6963RequestProvider: () => {
      // No-op — no wallet provider
    },

    viewToken: async () => {
      return { error: { type: 'rejected_by_user' as const } } as any;
    },

    sendToken: async () => {
      return { error: { type: 'rejected_by_user' as const } } as any;
    },

    swapToken: async () => {
      return { error: { type: 'rejected_by_user' as const } } as any;
    },

    requestCameraAndMicrophoneAccess: async () => {
      return { error: { type: 'rejected_by_user' as const } } as any;
    },

    updateBackState: async () => {
      // No-op for now — could wire to Android back button in future
    },
  }), [context, user, domain, activeMiniApp, closeMiniApp, hideSplash, setPrimaryButton, addToStore, isMiniAppAdded, openMiniAppInStore, onComposeCast, router]);

  const { onMessage, emit } = useWebViewRpcAdapter({
    webViewRef,
    domain,
    sdk,
    debug: __DEV__,
  });

  return {
    webViewRef,
    onMessage,
    emit,
    context,
  };
}
