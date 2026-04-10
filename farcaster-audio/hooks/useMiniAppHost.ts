import { useRef, useCallback, useMemo } from 'react';
import { Linking } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useWebViewRpcAdapter } from '@farcaster/miniapp-host-react-native';
import type WebView from 'react-native-webview';
import { SignIn, AddMiniApp, SignManifest } from '@farcaster/miniapp-core/dist/actions';
import type { MiniAppHost, MiniAppHostCapability, SetPrimaryButtonOptions, MiniAppContext } from '@/types/miniapp';
import { useAuthStore } from '@/stores/authStore';
import { useMiniAppStore } from '@/stores/miniappStore';
import { getAuthAddressStatus, signSiwfMessage } from '@/services/authAddress';

// Juke's Farcaster FID — replace with actual value when registered
const JUKE_CLIENT_FID = 0;

const SUPPORTED_CAPABILITIES: MiniAppHostCapability[] = [
  'actions.ready',
  'actions.openUrl',
  'actions.close',
  'actions.setPrimaryButton',
  'actions.signIn',
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
        throw new AddMiniApp.InvalidDomainManifest();
      }
      await addToStore(domain, config);
      return {};
    },

    // Legacy alias
    addFrame: async () => {
      const config = activeMiniApp?.config;
      if (!config) {
        throw new AddMiniApp.InvalidDomainManifest();
      }
      await addToStore(domain, config);
      return {};
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

    // --- Auth ---

    signIn: async (options: { nonce: string; notBefore?: string; expirationTime?: string; acceptAuthAddress?: boolean }) => {
      const fid = user?.fid;
      if (!fid) {
        throw new SignIn.RejectedByUser();
      }

      // Fast path: SecureStore-backed cache returns 'approved' without any
      // network call. Only if the user has never approved do we surface the
      // setup prompt, and we re-use the cache read the setup flow has
      // already populated on success.
      const status = await getAuthAddressStatus(fid);

      if (status !== 'approved') {
        const proceed = await useMiniAppStore.getState().requestAuthSetup();
        if (!proceed) {
          throw new SignIn.RejectedByUser();
        }
        // The setup flow persists 'approved' in SecureStore before
        // resolving proceed=true, so this read is cache-only (no network).
        const postSetup = await getAuthAddressStatus(fid);
        if (postSetup !== 'approved') {
          throw new SignIn.RejectedByUser();
        }
      }

      const { signature, message } = await signSiwfMessage(fid, {
        nonce: options.nonce,
        domain,
        notBefore: options.notBefore,
        expirationTime: options.expirationTime,
      });
      return { signature, message, authMethod: 'authAddress' as const };
    },

    signManifest: async () => {
      throw new SignManifest.RejectedByUser();
    },

    ethProviderRequest: async () => {
      throw Object.assign(new Error('Wallet not available'), { code: 4900 });
    },

    eip6963RequestProvider: () => {
      // No wallet providers to announce
    },

    viewToken: async () => {
      throw Object.assign(new Error('Not supported'), { code: 4900 });
    },

    sendToken: async () => {
      throw Object.assign(new Error('Not supported'), { code: 4900 });
    },

    swapToken: async () => {
      throw Object.assign(new Error('Not supported'), { code: 4900 });
    },

    requestCameraAndMicrophoneAccess: async () => {
      throw Object.assign(new Error('Not supported'), { code: 4900 });
    },

    updateBackState: async () => {
      // No-op for now — could wire to Android back button in future
    },
  }), [context, user, domain, activeMiniApp, closeMiniApp, hideSplash, setPrimaryButton, addToStore, openMiniAppInStore, onComposeCast, router]);

  // Minimal EIP-1193 provider that rejects all requests (no wallet support yet)
  const noopProvider = useMemo(() => {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();
    return {
      request: async () => {
        throw { code: 4900, message: 'Wallet not available' };
      },
      on: (event: string, fn: (...args: any[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(fn);
      },
      removeListener: (event: string, fn: (...args: any[]) => void) => {
        listeners.get(event)?.delete(fn);
      },
    };
  }, []);

  const { onMessage, emit } = useWebViewRpcAdapter({
    webViewRef,
    domain,
    sdk,
    ethProvider: noopProvider as any,
    debug: __DEV__,
  });

  return {
    webViewRef,
    onMessage,
    emit,
    context,
  };
}
