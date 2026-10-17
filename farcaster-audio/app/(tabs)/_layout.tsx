import { useCallback } from "react";
import { Pressable } from "react-native";
import { Tabs, useRouter } from "expo-router";
import { useAuthStore } from "@/stores/authStore";
import { useComposeStore } from "@/stores/composeStore";
import { Avatar } from "@/components/common/Avatar";
import { GlassTabBar } from "@/components/navigation/GlassTabBar";
import { GlobalComposeModal } from "@/components/feed/GlobalComposeModal";
import { useTheme } from "@/hooks/useTheme";
import { useMessagesBadge } from "@/hooks/useMessagesBadge";
import { NewMessageButton } from "@/components/messages/NewMessageButton";
import { HeaderSearchButton } from "@/components/navigation/HeaderSearchButton";

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

export default function TabLayout() {
  const { colors } = useTheme();
  const requestCompose = useComposeStore((s) => s.requestCompose);
  const handleCompose = useCallback(() => requestCompose(), [requestCompose]);
  // Inbox unread badge + realtime events, kept alive across all tabs.
  useMessagesBadge();

  return (
    <>
      <Tabs
        tabBar={(props) => <GlassTabBar {...props} onCompose={handleCompose} />}
        screenOptions={{
          headerStyle: { backgroundColor: colors.background.surface },
          headerTintColor: colors.text.primary,
          headerTitleAlign: "center",
          // GlassTabBar is positioned over the screen. Give React Navigation no
          // footer height to reserve; otherwise it leaves an opaque-looking
          // background band beneath the floating navigation surface.
          tabBarStyle: {
            position: "absolute",
            height: 0,
            backgroundColor: "transparent",
            borderTopWidth: 0,
            elevation: 0,
            shadowOpacity: 0,
          },
          // Search sits top left so the bottom bar stays two-and-two around
          // compose.
          headerLeft: () => (
            <HeaderSearchButton href="/search" label="Search" />
          ),
          headerLeftContainerStyle: { paddingLeft: 16 },
          headerRight: () => <HeaderAvatar />,
          headerRightContainerStyle: { paddingRight: 16 },
        }}
      >
        <Tabs.Screen name="index" options={{ title: "Home" }} />
        <Tabs.Screen
          name="messages"
          options={{
            title: "Messages",
            headerLeft: () => (
              <HeaderSearchButton
                href="/messages/search"
                label="Search messages"
              />
            ),
            headerRight: () => <NewMessageButton />,
          }}
        />
        <Tabs.Screen
          name="notifications"
          options={{ title: "Notifications" }}
        />
      </Tabs>
      <GlobalComposeModal />
    </>
  );
}
