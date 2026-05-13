import { useCallback } from "react";
import { Pressable } from "react-native";
import { Tabs, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "@/stores/authStore";
import { useComposeStore } from "@/stores/composeStore";
import { Avatar } from "@/components/common/Avatar";
import { GlassTabBar } from "@/components/navigation/GlassTabBar";
import { useTheme } from "@/hooks/useTheme";

function HeaderAvatar() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);

  return (
    <Pressable
      onPress={() => router.push("/settings")}
      hitSlop={8}
      accessibilityLabel="Settings"
    >
      <Avatar
        pfpUrl={user?.pfp_url ?? null}
        displayName={user?.display_name || user?.username || ""}
        size="sm"
      />
    </Pressable>
  );
}

function HeaderSearchButton() {
  const router = useRouter();
  const { colors } = useTheme();

  return (
    <Pressable
      onPress={() => router.push("/search")}
      hitSlop={8}
      accessibilityLabel="Search"
      accessibilityRole="button"
    >
      <Ionicons
        name="search-outline"
        size={24}
        color={colors.text.primary}
      />
    </Pressable>
  );
}

export default function TabLayout() {
  const { colors } = useTheme();
  const requestCompose = useComposeStore((s) => s.requestCompose);
  const handleCompose = useCallback(() => requestCompose(), [requestCompose]);

  return (
    <Tabs
      tabBar={(props) => <GlassTabBar {...props} onCompose={handleCompose} />}
      screenOptions={{
        headerStyle: { backgroundColor: colors.background.surface },
        headerTintColor: colors.text.primary,
        tabBarStyle: { position: "absolute" },
        headerRight: () => <HeaderAvatar />,
        headerRightContainerStyle: { paddingRight: 16 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          headerLeft: () => <HeaderSearchButton />,
          headerLeftContainerStyle: { paddingLeft: 16 },
        }}
      />
      <Tabs.Screen name="notifications" options={{ title: "Notifications" }} />
    </Tabs>
  );
}
