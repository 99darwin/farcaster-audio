import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useRouter } from "expo-router";
import { useNotificationStore } from "@/stores/notificationStore";
import { useAuthStore } from "@/stores/authStore";
import { useMessageStore } from "@/stores/messageStore";
import { GlassView } from "@/components/common/GlassView";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { haptic } from "@/utils/haptics";

export const TAB_BAR_TOTAL_HEIGHT = 64;
export const TAB_BAR_CONTENT_INSET = TAB_BAR_TOTAL_HEIGHT + 16;
const TAB_BUTTON_SIZE = 48;
const MESSAGES_BADGE_MAX = 99;

type TabRouteName = "index" | "messages" | "notifications";

interface GlassTabBarProps extends BottomTabBarProps {
  onCompose?: () => void;
}

/**
 * One centered navigation surface: compose holds the visual center, flanked
 * by Home + Messages and Notifications + Profile. Search lives in the tab
 * screens' header (top left). The bar floats above the safe area;
 * tab screens reserve TAB_BAR_CONTENT_INSET so their last row stays reachable.
 */
export function GlassTabBar({
  state,
  navigation,
  onCompose,
}: GlassTabBarProps) {
  const insets = useSafeAreaInsets();
  const { colors, glass } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const userFid = useAuthStore((s) => s.user?.fid);
  const messagesUnread = useMessageStore((s) => s.unreadTotal);
  const isMessagingUnavailable = useMessageStore(
    (s) => s.availability === "unavailable",
  );

  const renderBadge = (routeName: TabRouteName) => {
    if (routeName === "notifications" && unreadCount > 0) {
      return (
        <View
          testID="notification-badge"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.badge}
        >
          <Text style={styles.badgeText}>
            {unreadCount >= 20 ? "20+" : unreadCount}
          </Text>
        </View>
      );
    }
    if (routeName === "messages" && messagesUnread > 0) {
      return (
        <View
          testID="messages-badge"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.badge}
        >
          <Text style={styles.badgeText}>
            {messagesUnread > MESSAGES_BADGE_MAX
              ? `${MESSAGES_BADGE_MAX}+`
              : messagesUnread}
          </Text>
        </View>
      );
    }
    return null;
  };

  const getBadgeHint = (routeName: TabRouteName): string | undefined => {
    if (routeName === "notifications" && unreadCount > 0) {
      return `${unreadCount} unread ${unreadCount === 1 ? "notification" : "notifications"}`;
    }
    if (routeName === "messages" && messagesUnread > 0) {
      return `${messagesUnread} unread ${messagesUnread === 1 ? "message" : "messages"}`;
    }
    return undefined;
  };

  const renderTab = (routeName: TabRouteName) => {
    if (routeName === "messages" && isMessagingUnavailable) return null;
    const index = state.routes.findIndex((route) => route.name === routeName);
    if (index < 0) return null;
    const route = state.routes[index];
    const isFocused = state.index === index;
    const tabConfig = getTabConfig(routeName, isFocused);

    const onPress = () => {
      haptic.selection();
      const event = navigation.emit({
        type: "tabPress",
        target: route.key,
        canPreventDefault: true,
      });
      if (!isFocused && !event.defaultPrevented) {
        navigation.navigate(route.name, route.params);
      }
      // A focused, non-prevented retap is a genuine visit and refresh intent.
      // New/unfocused navigation is cleared by the Notifications screen only
      // after it actually receives focus and persists the last-seen timestamp.
      if (
        routeName === "notifications" &&
        isFocused &&
        !event.defaultPrevented
      ) {
        markAllRead();
      }
    };

    return (
      <Pressable
        key={route.key}
        onPress={onPress}
        accessibilityRole="tab"
        accessibilityState={{ selected: isFocused }}
        accessibilityLabel={tabConfig.label}
        accessibilityHint={getBadgeHint(routeName)}
        testID={`tab-${routeName}`}
        style={({ pressed }) => [
          styles.tabButton,
          isFocused && styles.activeTab,
          pressed && styles.pressed,
        ]}
      >
        <View style={styles.iconFrame}>
          <Ionicons
            name={tabConfig.iconName as keyof typeof Ionicons.glyphMap}
            size={23}
            color={isFocused ? colors.text.primary : colors.text.secondary}
          />
          {renderBadge(routeName)}
        </View>
        {isFocused && <View style={styles.selectedDot} />}
      </Pressable>
    );
  };

  return (
    <View
      testID="glass-tab-bar"
      style={[styles.barArea, { bottom: insets.bottom + 8 }]}
      pointerEvents="box-none"
    >
      <GlassView
        testID="tab-bar-glass-surface"
        style={styles.tabBar}
        // Use the native adaptive material with a deliberately light tint so
        // the feed stays visually present beneath the floating nav.
        tint="default"
        blurIntensity={glass.navigationBlurIntensity}
        overlayColor={glass.navigationOverlayColor}
      >
        {renderTab("index")}
        {renderTab("messages")}

        <Pressable
          onPress={() => {
            if (!onCompose) return;
            haptic.selection();
            onCompose();
          }}
          accessibilityLabel="New cast"
          accessibilityRole="button"
          accessibilityHint="Opens the composer over the current screen"
          accessibilityState={{ disabled: !onCompose }}
          disabled={!onCompose}
          style={({ pressed }) => [
            styles.composeButton,
            { backgroundColor: colors.accent },
            pressed && styles.composePressed,
          ]}
        >
          <Ionicons name="add" size={29} color={colors.text.primary} />
        </Pressable>

        {renderTab("notifications")}

        <Pressable
          onPress={() => {
            if (!userFid) return;
            haptic.selection();
            router.push(`/profile/${userFid}`);
          }}
          accessibilityRole="button"
          accessibilityLabel="Profile"
          accessibilityState={{ disabled: !userFid }}
          disabled={!userFid}
          style={({ pressed }) => [styles.tabButton, pressed && styles.pressed]}
        >
          <Ionicons name="person-outline" size={23} color={colors.text.secondary} />
        </Pressable>
      </GlassView>
    </View>
  );
}

function getTabConfig(routeName: TabRouteName, isFocused: boolean) {
  if (routeName === "notifications") {
    return {
      label: "Notifications",
      iconName: isFocused ? "notifications" : "notifications-outline",
    };
  }
  if (routeName === "messages") {
    return {
      label: "Messages",
      iconName: isFocused ? "chatbubbles" : "chatbubbles-outline",
    };
  }
  return {
    label: "Home",
    iconName: isFocused ? "home" : "home-outline",
  };
}

const useStyles = () =>
  useThemedStyles(({ colors, glass }) => ({
    barArea: {
      position: "absolute",
      left: 12,
      right: 12,
      height: TAB_BAR_TOTAL_HEIGHT,
      alignItems: "center",
      justifyContent: "center",
    },
    tabBar: {
      width: "100%",
      maxWidth: 368,
      height: TAB_BAR_TOTAL_HEIGHT,
      paddingHorizontal: 7,
      borderRadius: glass.pillRadius,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: "transparent",
    },
    tabButton: {
      width: TAB_BUTTON_SIZE,
      height: TAB_BUTTON_SIZE,
      borderRadius: 18,
      alignItems: "center",
      justifyContent: "center",
      position: "relative",
      overflow: "visible",
    },
    activeTab: {
      backgroundColor: glass.borderColor,
    },
    pressed: {
      opacity: 0.62,
    },
    selectedDot: {
      position: "absolute",
      bottom: 4,
      width: 4,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.accent,
    },
    iconFrame: {
      width: 28,
      height: 28,
      alignItems: "center",
      justifyContent: "center",
      overflow: "visible",
    },
    composeButton: {
      width: 54,
      height: 54,
      borderRadius: 27,
      alignItems: "center",
      justifyContent: "center",
      shadowColor: colors.accent,
      shadowOffset: { width: 0, height: 5 },
      shadowOpacity: 0.32,
      shadowRadius: 9,
      elevation: 7,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: glass.borderColor,
    },
    composePressed: {
      opacity: 0.78,
      transform: [{ scale: 0.96 }],
    },
    badge: {
      position: "absolute",
      top: -7,
      right: -9,
      backgroundColor: colors.danger,
      borderRadius: 10,
      minWidth: 20,
      height: 20,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 4,
      borderWidth: 1.5,
      borderColor: colors.background.main,
      shadowColor: "#000",
      shadowOpacity: 0.28,
      shadowRadius: 3,
      shadowOffset: { width: 0, height: 1 },
      elevation: 3,
    },
    badgeText: {
      color: "#fff",
      fontSize: 10,
      fontWeight: "700",
      lineHeight: 12,
    },
  }));
