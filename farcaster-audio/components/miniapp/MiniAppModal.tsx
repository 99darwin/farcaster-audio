import { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Linking,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import { WebView } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useMiniAppHost } from '@/hooks/useMiniAppHost';
import { useMiniAppStore } from '@/stores/miniappStore';
import { AuthAddressSetup } from '@/components/miniapp/AuthAddressSetup';
import { GlassView } from '@/components/common/GlassView';
import { colors, glass, typography } from '@/constants/theme';
import type { MiniAppConfig } from '@/types/miniapp';

const SLIDE_DURATION = 300;
const SLIDE_EASING = Easing.bezier(0.25, 0.1, 0.25, 1);

/**
 * Full-screen miniapp host with slide animation.
 * WebView stays mounted when minimized so state is preserved.
 */
export function MiniAppModal() {
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const activeMiniApp = useMiniAppStore((s) => s.activeMiniApp);
  const isMinimized = useMiniAppStore((s) => s.isMinimized);
  const isSplashVisible = useMiniAppStore((s) => s.isSplashVisible);
  const primaryButton = useMiniAppStore((s) => s.primaryButton);
  const closeMiniApp = useMiniAppStore((s) => s.closeMiniApp);
  const minimizeMiniApp = useMiniAppStore((s) => s.minimizeMiniApp);

  // Track whether we should render at all (delayed unmount after slide-out)
  const [shouldRender, setShouldRender] = useState(false);
  const translateY = useSharedValue(screenHeight);

  useEffect(() => {
    if (activeMiniApp && !isMinimized) {
      // Opening or maximizing: render immediately, then slide up
      setShouldRender(true);
      translateY.value = withTiming(0, { duration: SLIDE_DURATION, easing: SLIDE_EASING });
    } else if (activeMiniApp && isMinimized) {
      // Minimizing: slide down, then move offscreen
      translateY.value = withTiming(screenHeight, { duration: SLIDE_DURATION, easing: SLIDE_EASING });
    } else {
      // Closing: slide down, then unmount
      translateY.value = withTiming(screenHeight, { duration: SLIDE_DURATION, easing: SLIDE_EASING }, () => {
        runOnJS(setShouldRender)(false);
      });
    }
  }, [activeMiniApp, isMinimized, screenHeight]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  if (!shouldRender || !activeMiniApp) return null;

  return (
    <Animated.View
      style={[styles.fullScreenOverlay, animatedStyle]}
      pointerEvents={isMinimized ? 'none' : 'auto'}
    >
      <MiniAppContent
        url={activeMiniApp.url}
        domain={activeMiniApp.domain}
        config={activeMiniApp.config}
        isSplashVisible={isSplashVisible}
        primaryButton={primaryButton}
        onClose={closeMiniApp}
        onMinimize={minimizeMiniApp}
        insets={insets}
      />
      <AuthAddressSetup />
    </Animated.View>
  );
}

/**
 * Floating mini bar shown when a miniapp is minimized.
 * Matches the SpaceMiniBar glass UI pattern.
 */
export function MiniAppMiniBar({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const activeMiniApp = useMiniAppStore((s) => s.activeMiniApp);
  const isMinimized = useMiniAppStore((s) => s.isMinimized);
  const maximizeMiniApp = useMiniAppStore((s) => s.maximizeMiniApp);
  const closeMiniApp = useMiniAppStore((s) => s.closeMiniApp);

  if (!activeMiniApp || !isMinimized) return null;

  const appName = activeMiniApp.config?.name ?? activeMiniApp.domain;

  return (
    <GlassView style={[miniBarStyles.container, { bottom: bottomOffset }]}>
      <Pressable
        style={miniBarStyles.content}
        onPress={maximizeMiniApp}
        accessibilityLabel={`Open ${appName}`}
        accessibilityRole="button"
      >
        <View style={miniBarStyles.leftSection}>
          <View style={miniBarStyles.appDot} />
          <Text style={miniBarStyles.title} numberOfLines={1}>{appName}</Text>
        </View>
        <View style={miniBarStyles.controls}>
          <Pressable
            onPress={maximizeMiniApp}
            style={miniBarStyles.controlButton}
            accessibilityLabel={`Expand ${appName}`}
            accessibilityRole="button"
          >
            <Ionicons name="expand-outline" size={18} color={colors.text.primary} />
          </Pressable>
          <View style={miniBarStyles.divider} />
          <Pressable
            onPress={closeMiniApp}
            style={miniBarStyles.controlButton}
            accessibilityLabel="Close mini app"
            accessibilityRole="button"
          >
            <Ionicons name="close" size={18} color={colors.error} />
          </Pressable>
        </View>
      </Pressable>
    </GlassView>
  );
}

// --- MiniAppContent (internal) ---

interface MiniAppContentProps {
  url: string;
  domain: string;
  config: MiniAppConfig | null;
  isSplashVisible: boolean;
  primaryButton: { text: string; loading: boolean; disabled: boolean; hidden: boolean } | null;
  onClose: () => void;
  onMinimize: () => void;
  insets: { top: number; bottom: number; left: number; right: number };
}

function MiniAppContent({
  url,
  domain,
  config,
  isSplashVisible,
  primaryButton,
  onClose,
  onMinimize,
  insets,
}: MiniAppContentProps) {
  const [isWebViewLoading, setIsWebViewLoading] = useState(true);

  const handleComposeCast = useCallback(async (options: {
    text?: string;
    embeds?: string[];
    parentHash?: string;
    channelKey?: string;
  }) => {
    return null;
  }, []);

  const { webViewRef, onMessage, emit } = useMiniAppHost({
    domain,
    launchUrl: url,
    onComposeCast: handleComposeCast,
  });

  const handleShouldStartLoad = useCallback((request: ShouldStartLoadRequest): boolean => {
    const requestUrl = request.url;
    if (requestUrl.startsWith('about:')) return true;
    try {
      const parsed = new URL(requestUrl);
      if (parsed.protocol !== 'https:') return false;
      const requestHost = parsed.hostname;
      if (requestHost === domain || requestHost.endsWith(`.${domain}`)) {
        return true;
      }
      if (parsed.protocol === 'https:') {
        Linking.openURL(requestUrl).catch(() => {});
      }
      return false;
    } catch {
      return false;
    }
  }, [domain]);

  const handlePrimaryButtonPress = useCallback(() => {
    if (emit && primaryButton && !primaryButton.disabled && !primaryButton.loading) {
      emit({ event: 'primary_button_clicked' });
    }
  }, [emit, primaryButton]);

  const appName = config?.name ?? domain;
  const splashImage = config?.splashImageUrl ?? config?.iconUrl;
  const splashBgColor = config?.splashBackgroundColor ?? colors.background.main;

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          onPress={onMinimize}
          style={styles.headerButton}
          accessibilityLabel="Minimize mini app"
          accessibilityRole="button"
          hitSlop={8}
        >
          <Ionicons name="chevron-down" size={24} color={colors.text.primary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {appName}
        </Text>
        <View style={styles.headerRight}>
          {primaryButton && !primaryButton.hidden ? (
            <Pressable
              onPress={handlePrimaryButtonPress}
              disabled={primaryButton.disabled || primaryButton.loading}
              style={[
                styles.primaryButton,
                (primaryButton.disabled || primaryButton.loading) && styles.primaryButtonDisabled,
              ]}
            >
              {primaryButton.loading ? (
                <ActivityIndicator size="small" color={colors.text.primary} />
              ) : (
                <Text style={styles.primaryButtonText}>{primaryButton.text}</Text>
              )}
            </Pressable>
          ) : (
            <Pressable
              onPress={onClose}
              style={styles.headerButton}
              accessibilityLabel="Close mini app"
              accessibilityRole="button"
              hitSlop={8}
            >
              <Ionicons name="close" size={22} color={colors.text.secondary} />
            </Pressable>
          )}
        </View>
      </View>

      {/* WebView */}
      <View style={styles.webViewContainer}>
        <WebView
          ref={webViewRef}
          source={{ uri: url }}
          onMessage={onMessage}
          onShouldStartLoadWithRequest={handleShouldStartLoad}
          onLoadStart={() => setIsWebViewLoading(true)}
          onLoadEnd={() => setIsWebViewLoading(false)}
          style={styles.webView}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={['https://*']}
          scrollEnabled
          bounces={false}
        />

        {/* Splash Screen Overlay */}
        {isSplashVisible && (
          <View style={[styles.splashOverlay, { backgroundColor: splashBgColor }]}>
            {splashImage && (
              <Image
                source={{ uri: splashImage }}
                style={styles.splashImage}
                contentFit="contain"
                transition={200}
              />
            )}
            <Text style={styles.splashTitle}>{appName}</Text>
            <ActivityIndicator
              size="small"
              color={colors.text.secondary}
              style={styles.splashSpinner}
            />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fullScreenOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
    backgroundColor: colors.background.main,
  },
  container: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.background.border,
    backgroundColor: colors.background.surface,
  },
  headerButton: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
  },
  headerTitle: {
    flex: 1,
    textAlign: 'center',
    color: colors.text.primary,
    fontSize: typography.size.md,
    fontWeight: typography.weight.semibold,
    marginHorizontal: 8,
  },
  headerRight: {
    minWidth: 36,
    alignItems: 'flex-end',
  },
  primaryButton: {
    backgroundColor: colors.purple,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    minWidth: 60,
    alignItems: 'center',
  },
  primaryButtonDisabled: {
    opacity: 0.5,
  },
  primaryButtonText: {
    color: colors.text.primary,
    fontSize: typography.size.sm,
    fontWeight: typography.weight.semibold,
  },
  webViewContainer: {
    flex: 1,
  },
  webView: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  splashOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  splashImage: {
    width: 80,
    height: 80,
    borderRadius: 16,
    marginBottom: 16,
  },
  splashTitle: {
    color: colors.text.primary,
    fontSize: typography.size.lg,
    fontWeight: typography.weight.semibold,
  },
  splashSpinner: {
    marginTop: 24,
  },
});

const miniBarStyles = StyleSheet.create({
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    marginHorizontal: 12,
    borderRadius: glass.capsuleRadius,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  leftSection: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 8,
  },
  appDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.purple,
  },
  title: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '600',
    flexShrink: 1,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  controlButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 44,
    minHeight: 44,
  },
  divider: {
    width: 1,
    height: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },
});
