import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, Pressable, Switch, StyleSheet } from "react-native";
import Toast from "react-native-toast-message";
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
import {
  getMyLeaderboardStanding,
  setLeaderboardOptOut,
} from "@/services/leaderboard";
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

  const [leaderboardOptOut, setLeaderboardOptOutState] = useState(false);
  const leaderboardOptOutRef = useRef(leaderboardOptOut);
  leaderboardOptOutRef.current = leaderboardOptOut;
  // Monotonic toggle id: only the latest PUT (or its error revert) may
  // write state, so a slow first response can't undo a rapid re-toggle.
  // Also blocks the in-flight initial GET from clobbering a user choice —
  // the PUT response is the source of truth once the user interacts.
  const optOutSeq = useRef(0);

  useEffect(() => {
    if (!user) return;
    getMyLeaderboardStanding()
      .then((standing) => {
        if (optOutSeq.current === 0) {
          setLeaderboardOptOutState(standing.opt_out);
        }
      })
      .catch(() => {});
  }, [user]);

  const handleLeaderboardOptOutToggle = useCallback(async (value: boolean) => {
    const seq = ++optOutSeq.current;
    const previous = leaderboardOptOutRef.current;
    // Optimistic update
    setLeaderboardOptOutState(value);
    try {
      const response = await setLeaderboardOptOut(value);
      // Server-confirmed value wins over the optimistic one — but only if
      // no newer toggle superseded this request while it was in flight.
      if (seq === optOutSeq.current) {
        setLeaderboardOptOutState(response.opt_out);
      }
    } catch {
      if (seq !== optOutSeq.current) return;
      // Revert to the last known state and tell the user — this is a
      // privacy control, so a silent snap-back is not acceptable.
      setLeaderboardOptOutState(previous);
      Toast.show({
        type: "error",
        text1: "Couldn't update leaderboard visibility",
      });
    }
  }, []);

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
          onPress={() => {
            router.dismiss();
            router.push("/bookmarks");
          }}
          accessibilityRole="button"
          accessibilityLabel="Bookmarks"
        >
          <Ionicons
            name="bookmark-outline"
            size={20}
            color={colors.purple}
          />
          <Text style={styles.rowText}>Bookmarks</Text>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={colors.text.secondary}
            style={{ marginLeft: "auto" }}
          />
        </Pressable>
        <Pressable
          style={styles.row}
          onPress={() => {
            router.dismiss();
            router.push("/leaderboard");
          }}
          accessibilityRole="button"
          accessibilityLabel="Leaderboard"
        >
          <Ionicons name="trophy-outline" size={20} color={colors.purple} />
          <Text style={styles.rowText}>Leaderboard</Text>
          <Ionicons
            name="chevron-forward"
            size={16}
            color={colors.text.secondary}
            style={{ marginLeft: "auto" }}
          />
        </Pressable>
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
            <Text style={styles.rowLabelText} numberOfLines={1}>
              Winamp Mode
            </Text>
            <Text style={styles.rowHint} numberOfLines={1}>
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
          />
        </View>
      </View>

      {user && (
        <View style={styles.section}>
          <View style={styles.row}>
            <Ionicons name="eye-off-outline" size={20} color={colors.purple} />
            <View style={styles.rowLabelWrap}>
              <Text style={styles.rowLabelText} numberOfLines={1}>
                Hide me from the leaderboard
              </Text>
              <Text style={styles.rowHint} numberOfLines={1}>
                Opt out of recognition standings
              </Text>
            </View>
            <Switch
              value={leaderboardOptOut}
              onValueChange={handleLeaderboardOptOutToggle}
              trackColor={{
                false: colors.background.border,
                true: colors.purple,
              }}
              thumbColor="#ffffff"
            />
          </View>
        </View>
      )}

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
      minWidth: 0,
    },
    rowText: {
      color: colors.text.primary,
      fontSize: 16,
      flex: 1,
    },
    rowLabelText: {
      color: colors.text.primary,
      fontSize: 16,
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
