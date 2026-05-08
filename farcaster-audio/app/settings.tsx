import { View, Text, Pressable, Switch, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuthStore } from "@/stores/authStore";
import { useSpaceStore } from "@/stores/spaceStore";
import { usePrefsStore, type AppearancePref } from "@/stores/prefsStore";
import { Avatar } from "@/components/common/Avatar";
import { spacing } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import * as livekitService from "@/services/livekit";
import * as api from "@/services/api";
import { unregisterPushToken } from "@/hooks/usePushNotifications";

const APPEARANCE_LABELS: Record<AppearancePref, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

export default function SettingsScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useStyles();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const room = useSpaceStore((s) => s.room);
  const leaveSpace = useSpaceStore((s) => s.leaveSpace);
  const winampMode = usePrefsStore((s) => s.winampMode);
  const setWinampMode = usePrefsStore((s) => s.setWinampMode);
  const appearancePref = usePrefsStore((s) => s.appearancePref);

  const handleLogout = async () => {
    if (room) {
      try {
        await api.leaveRoom(room.id);
      } catch {}
      await livekitService.disconnectFromRoom();
      leaveSpace();
    }
    await unregisterPushToken();
    router.dismiss();
    await logout();
  };

  return (
    <View style={styles.container}>
      {user && (
        <Pressable
          style={styles.profile}
          onPress={() => {
            router.dismiss();
            router.push(`/profile/${user.fid}`);
          }}
          accessibilityRole="button"
          accessibilityLabel="View your profile"
        >
          <Avatar
            pfpUrl={user.pfp_url ?? null}
            displayName={user.display_name || user.username || ""}
            size="lg"
          />
          <View style={styles.profileText}>
            <Text style={styles.displayName}>{user.display_name}</Text>
            <Text style={styles.username}>@{user.username}</Text>
          </View>
          <Ionicons
            name="chevron-forward"
            size={20}
            color={colors.text.secondary}
          />
        </Pressable>
      )}

      <View style={styles.section}>
        <Pressable
          style={styles.row}
          onPress={() => router.push("/notification-settings")}
          accessibilityRole="button"
          accessibilityLabel="Notification settings"
        >
          <Ionicons
            name="notifications-outline"
            size={20}
            color={colors.purple}
          />
          <Text style={styles.rowText}>Notifications</Text>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={colors.text.secondary}
            style={{ marginLeft: "auto" }}
          />
        </Pressable>
      </View>

      <View style={styles.section}>
        <Pressable
          style={styles.row}
          onPress={() => router.push("/appearance-settings")}
          accessibilityRole="button"
          accessibilityLabel="Appearance settings"
        >
          <Ionicons name="contrast-outline" size={20} color={colors.purple} />
          <Text style={styles.rowText}>Appearance</Text>
          <Text style={styles.rowValue}>
            {APPEARANCE_LABELS[appearancePref]}
          </Text>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={colors.text.secondary}
          />
        </Pressable>
      </View>

      {user?.is_admin && (
        <View style={styles.section}>
          <Pressable
            style={styles.row}
            onPress={() => {
              router.dismiss();
              router.push("/admin");
            }}
            accessibilityRole="button"
            accessibilityLabel="Admin panel"
          >
            <Ionicons
              name="shield-checkmark-outline"
              size={20}
              color={colors.purple}
            />
            <Text style={styles.rowText}>Admin</Text>
            <Ionicons
              name="chevron-forward"
              size={16}
              color={colors.text.secondary}
              style={{ marginLeft: "auto" }}
            />
          </Pressable>
        </View>
      )}

      <View style={styles.section}>
        <View style={styles.row}>
          <Ionicons
            name="musical-notes-outline"
            size={20}
            color={colors.purple}
          />
          <View style={styles.rowLabelWrap}>
            <Text style={styles.rowText}>Winamp Mode</Text>
            <Text style={styles.rowHint}>
              Retro player skin for audio spaces
            </Text>
          </View>
          <Switch
            value={winampMode}
            onValueChange={setWinampMode}
            trackColor={{
              false: colors.background.border,
              true: colors.purple,
            }}
            thumbColor="#ffffff"
            style={{ marginLeft: "auto" }}
          />
        </View>
      </View>

      <View style={styles.section}>
        <Pressable
          style={styles.row}
          onPress={handleLogout}
          accessibilityRole="button"
          accessibilityLabel="Log out"
        >
          <Ionicons name="log-out-outline" size={20} color={colors.danger} />
          <Text style={styles.rowTextDanger}>Log Out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
    },
    profile: {
      flexDirection: "row",
      alignItems: "center",
      padding: spacing["2xl"],
      gap: spacing.lg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    profileText: {
      flex: 1,
    },
    displayName: {
      color: colors.text.primary,
      fontSize: 18,
      fontWeight: "700" as const,
    },
    username: {
      color: colors.text.secondary,
      fontSize: 14,
      marginTop: 2,
    },
    section: {
      marginTop: spacing.lg,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.background.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
      backgroundColor: colors.background.surface,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing["2xl"],
      paddingVertical: 14,
    },
    rowLabelWrap: {
      flex: 1,
    },
    rowText: {
      color: colors.text.primary,
      fontSize: 16,
      flex: 1,
    },
    rowValue: {
      color: colors.text.secondary,
      fontSize: 15,
      marginRight: spacing.xs,
    },
    rowHint: {
      color: colors.text.secondary,
      fontSize: 13,
      marginTop: 2,
    },
    rowTextDanger: {
      color: colors.danger,
      fontSize: 16,
    },
  }));
