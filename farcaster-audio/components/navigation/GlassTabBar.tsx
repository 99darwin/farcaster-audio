import { View, Text, Pressable, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { type BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useNotificationStore } from "@/stores/notificationStore";
import { GlassView } from "@/components/common/GlassView";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { haptic } from "@/utils/haptics";

export const TAB_BAR_TOTAL_HEIGHT = 60;

interface GlassTabBarProps extends BottomTabBarProps {
  onCompose?: () => void;
}

export function GlassTabBar({
  state,
  navigation,
  onCompose,
}: GlassTabBarProps) {
  const insets = useSafeAreaInsets();
  const { colors, glass } = useTheme();
  const styles = useStyles();
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const markAllRead = useNotificationStore((s) => s.markAllRead);

  const tabs = state.routes.map((route, index) => {
    const isFocused = state.index === index;
    const tabConfig = getTabConfig(route.name, isFocused);

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
      if (route.name === "notifications") {
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
        style={styles.tabButton}
      >
        {isFocused && <View style={styles.activeHighlight} />}
        <View>
          <Ionicons
            name={tabConfig.iconName as any}
            size={24}
            color={isFocused ? colors.text.primary : colors.text.secondary}
          />
          {route.name === "notifications" && unreadCount > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {unreadCount >= 20 ? "20+" : unreadCount}
              </Text>
            </View>
          )}
        </View>
      </Pressable>
    );
  });

  return (
    <View
      style={[styles.row, { bottom: insets.bottom + 8 }]}
      pointerEvents="box-none"
    >
      <GlassView style={styles.tabPill}>{tabs}</GlassView>

      <GlassView style={styles.composePill} overlayColor={glass.accentOverlay}>
        <Pressable
          onPress={onCompose}
          accessibilityLabel="New cast"
          accessibilityRole="button"
          style={styles.composeTouchTarget}
        >
          <Ionicons
            name="create-outline"
            size={24}
            color={colors.text.primary}
          />
        </Pressable>
      </GlassView>
    </View>
  );
}

function getTabConfig(routeName: string, isFocused: boolean) {
  if (routeName === "bookmarks") {
    return {
      label: "Bookmarks",
      iconName: isFocused ? "bookmark" : "bookmark-outline",
    };
  }
  if (routeName === "notifications") {
    return {
      label: "Notifications",
      iconName: isFocused ? "notifications" : "notifications-outline",
    };
  }
  return {
    label: "Home",
    iconName: isFocused ? "home" : "home-outline",
  };
}

const useStyles = () =>
  useThemedStyles(({ colors, glass }) => ({
    row: {
      position: "absolute",
      left: 16,
      right: 16,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      height: TAB_BAR_TOTAL_HEIGHT,
    },
    tabPill: {
      flexDirection: "row",
      alignItems: "center",
      height: TAB_BAR_TOTAL_HEIGHT,
      paddingHorizontal: 12,
      gap: 4,
      borderRadius: glass.pillRadius,
    },
    tabButton: {
      width: 48,
      height: 48,
      alignItems: "center",
      justifyContent: "center",
      position: "relative",
    },
    activeHighlight: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: glass.borderColor,
      borderRadius: 16,
    },
    composePill: {
      width: TAB_BAR_TOTAL_HEIGHT,
      height: TAB_BAR_TOTAL_HEIGHT,
      borderRadius: TAB_BAR_TOTAL_HEIGHT / 2,
    },
    composeTouchTarget: {
      width: TAB_BAR_TOTAL_HEIGHT,
      height: TAB_BAR_TOTAL_HEIGHT,
      alignItems: "center",
      justifyContent: "center",
    },
    badge: {
      position: "absolute",
      top: -4,
      right: -8,
      backgroundColor: colors.accent,
      borderRadius: 9,
      minWidth: 18,
      height: 18,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 4,
    },
    badgeText: {
      color: colors.text.primary,
      fontSize: 10,
      fontWeight: "700",
    },
  }));
