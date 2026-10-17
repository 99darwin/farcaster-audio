import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Pressable,
  Alert,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuthStore } from "@/stores/authStore";
import { spacing, radii, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { Avatar } from "@/components/common/Avatar";
import * as api from "@/services/api";
import type { Room } from "@/types/space";
import Toast from "react-native-toast-message";

export default function AdminScreen() {
  const isAdmin = useAuthStore((s) => s.user?.is_admin);
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useStyles();

  useEffect(() => {
    if (!isAdmin) {
      router.replace("/");
    }
  }, [isAdmin, router]);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [endingRoomId, setEndingRoomId] = useState<string | null>(null);
  const [stoppingRecordingId, setStoppingRecordingId] = useState<string | null>(null);
  const [isSettingUpWebhooks, setIsSettingUpWebhooks] = useState(false);

  const fetchRooms = useCallback(async () => {
    try {
      const data = await api.adminListRooms();
      setRooms(data.rooms);
    } catch (error) {
      Toast.show({
        type: "error",
        text1: "Failed to load rooms",
        text2: api.getErrorMessage(error),
      });
    }
  }, []);

  useEffect(() => {
    // Non-admins are redirected above; never hit admin endpoints for them.
    if (!isAdmin) return;
    fetchRooms().finally(() => setIsLoading(false));
  }, [isAdmin, fetchRooms]);

  // Every hook above runs unconditionally (Rules of Hooks); bail only after.
  if (!isAdmin) return null;

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await fetchRooms();
    setIsRefreshing(false);
  };

  const handleEndRoom = (room: Room) => {
    Alert.alert(
      "End Room",
      `Force-end "${room.title}" hosted by ${room.host.display_name}?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "End Room",
          style: "destructive",
          onPress: async () => {
            setEndingRoomId(room.id);
            try {
              await api.adminEndRoom(room.id);
              setRooms((prev) => prev.filter((r) => r.id !== room.id));
              Toast.show({ type: "success", text1: "Room ended" });
            } catch (error) {
              Toast.show({
                type: "error",
                text1: "Failed to end room",
                text2: api.getErrorMessage(error),
              });
            } finally {
              setEndingRoomId(null);
            }
          },
        },
      ],
    );
  };

  const handleStopRecording = (room: Room) => {
    const isOrphaned = room.status !== "active";
    Alert.alert(
      isOrphaned ? "Clear Stuck Recording" : "Stop Recording",
      isOrphaned
        ? `"${room.title}" already ended on Farcaster but its recording flag is stuck. Clear it now? If the worker is still alive the file is saved; otherwise the flag is just cleared.`
        : `Stop recording "${room.title}"? The file will be saved to the host's profile.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: isOrphaned ? "Clear Recording" : "Stop Recording",
          style: "destructive",
          onPress: async () => {
            setStoppingRecordingId(room.id);
            try {
              const result = await api.adminStopRecording(room.id);
              // Orphaned rooms are already ended — drop them from the
              // list entirely. Live rooms stay (recording flag cleared).
              setRooms((prev) =>
                isOrphaned
                  ? prev.filter((r) => r.id !== room.id)
                  : prev.map((r) =>
                      r.id === room.id ? { ...r, recording: false } : r,
                    ),
              );
              Toast.show({
                type: "success",
                text1:
                  result.status === "stopped"
                    ? "Recording saved"
                    : "Stuck recording cleared (no file)",
              });
            } catch (error) {
              Toast.show({
                type: "error",
                text1: "Failed to stop recording",
                text2: api.getErrorMessage(error),
              });
            } finally {
              setStoppingRecordingId(null);
            }
          },
        },
      ],
    );
  };

  const formatDuration = (startedAt: string): string => {
    const started = new Date(startedAt);
    const diffMs = Date.now() - started.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  };

  const renderRoom = ({ item: room }: { item: Room }) => {
    const isEnding = endingRoomId === room.id;
    const participantCount = room.speaker_count + room.listener_count;
    // An ended room that's still flagged recording is an orphaned
    // recording — surfaced here so it can be cleared. It has no live
    // participants and can't be "ended" again.
    const isOrphanedRecording = room.status !== "active" && room.recording;

    return (
      <View style={styles.roomCard}>
        <View style={styles.roomHeader}>
          <Avatar
            pfpUrl={room.host.pfp_url}
            displayName={room.host.display_name}
            size="sm"
          />
          <View style={styles.roomInfo}>
            <View style={styles.titleRow}>
              <Text style={styles.roomTitle} numberOfLines={1}>
                {room.title}
              </Text>
              {isOrphanedRecording && (
                <View style={styles.orphanBadge}>
                  <Text style={styles.orphanBadgeText}>STUCK</Text>
                </View>
              )}
            </View>
            <Text style={styles.roomMeta}>
              {room.host.display_name} · {participantCount} participant
              {participantCount !== 1 ? "s" : ""} ·{" "}
              {formatDuration(room.started_at)}
            </Text>
          </View>
          {!isOrphanedRecording && (
            <Pressable
              style={[styles.endButton, isEnding && styles.endButtonDisabled]}
              onPress={() => handleEndRoom(room)}
              disabled={isEnding}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`End room ${room.title}`}
            >
              {isEnding ? (
                <ActivityIndicator size="small" color={colors.danger} />
              ) : (
                <Ionicons name="close-circle" size={24} color={colors.danger} />
              )}
            </Pressable>
          )}
        </View>
        <View style={styles.roomStats}>
          <View style={styles.stat}>
            <Ionicons name="mic" size={14} color={colors.text.secondary} />
            <Text style={styles.statText}>{room.speaker_count}</Text>
          </View>
          <View style={styles.stat}>
            <Ionicons name="headset" size={14} color={colors.text.secondary} />
            <Text style={styles.statText}>{room.listener_count}</Text>
          </View>
          <Text style={styles.roomId}>{room.id.slice(0, 8)}</Text>
          {room.recording && (
            <Pressable
              style={[
                styles.stopRecordingButton,
                stoppingRecordingId === room.id && styles.endButtonDisabled,
              ]}
              onPress={() => handleStopRecording(room)}
              disabled={stoppingRecordingId === room.id}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Stop recording for ${room.title}`}
            >
              {stoppingRecordingId === room.id ? (
                <ActivityIndicator size="small" color={colors.accent} />
              ) : (
                <Ionicons name="radio-button-on" size={14} color={colors.accent} />
              )}
              <Text style={styles.stopRecordingText}>REC</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  };

  if (isLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={colors.purple} />
      </View>
    );
  }

  const handleSetupWebhooks = () => {
    Alert.alert(
      "Setup Push Webhooks",
      "Register Neynar webhooks for push notifications. This only needs to be done once. The webhook secrets will be shown — copy them into your env vars.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Setup",
          onPress: async () => {
            setIsSettingUpWebhooks(true);
            try {
              const data = await api.adminSetupWebhooks();
              const info = data.webhooks
                .map(
                  (w: {
                    id_var: string;
                    webhook_id: string;
                  }) => `${w.id_var}=${w.webhook_id}`,
                )
                .join("\n");
              Alert.alert(
                "Webhooks Created",
                `${info}\n\nSecrets are in Railway logs — copy them into your env vars.`,
              );
            } catch (error) {
              Toast.show({
                type: "error",
                text1: "Failed to setup webhooks",
                text2: api.getErrorMessage(error),
              });
            } finally {
              setIsSettingUpWebhooks(false);
            }
          },
        },
      ],
    );
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={rooms}
        keyExtractor={(room) => room.id}
        renderItem={renderRoom}
        contentContainerStyle={
          rooms.length === 0 ? styles.centered : styles.list
        }
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.text.secondary}
          />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons
              name="checkmark-circle-outline"
              size={48}
              color={colors.text.secondary}
            />
            <Text style={styles.emptyText}>No active rooms</Text>
          </View>
        }
        ListFooterComponent={
          <View style={styles.adminActions}>
            <Pressable
              style={[
                styles.webhookButton,
                isSettingUpWebhooks && styles.endButtonDisabled,
              ]}
              onPress={handleSetupWebhooks}
              disabled={isSettingUpWebhooks}
            >
              {isSettingUpWebhooks ? (
                <ActivityIndicator size="small" color={colors.purple} />
              ) : (
                <>
                  <Ionicons
                    name="notifications-outline"
                    size={18}
                    color={colors.purple}
                  />
                  <Text style={styles.webhookButtonText}>
                    Setup Push Webhooks
                  </Text>
                </>
              )}
            </Pressable>
          </View>
        }
      />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
    },
    centered: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: colors.background.main,
    },
    list: {
      padding: spacing.lg,
      gap: spacing.md,
    },
    roomCard: {
      backgroundColor: colors.background.surface,
      borderRadius: radii.md,
      padding: spacing.lg,
      gap: spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.background.border,
    },
    roomHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
    },
    roomInfo: {
      flex: 1,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
    },
    roomTitle: {
      flexShrink: 1,
      color: colors.text.primary,
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
    },
    orphanBadge: {
      backgroundColor: colors.danger,
      borderRadius: radii.sm,
      paddingHorizontal: 6,
      paddingVertical: 1,
    },
    orphanBadgeText: {
      color: colors.text.primary,
      fontSize: typography.size.xs,
      fontWeight: typography.weight.bold,
    },
    roomMeta: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      marginTop: 2,
    },
    endButton: {
      width: 44,
      height: 44,
      justifyContent: "center",
      alignItems: "center",
    },
    endButtonDisabled: {
      opacity: 0.5,
    },
    roomStats: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.lg,
      paddingLeft: 44,
    },
    stat: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.xs,
    },
    statText: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
    },
    roomId: {
      color: colors.text.placeholder,
      fontSize: typography.size.xs,
      fontFamily: "monospace",
      marginLeft: "auto",
    },
    stopRecordingButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    stopRecordingText: {
      color: colors.accent,
      fontSize: typography.size.xs,
      fontWeight: typography.weight.semibold,
    },
    empty: {
      alignItems: "center",
      gap: spacing.md,
    },
    emptyText: {
      color: colors.text.secondary,
      fontSize: typography.size.body,
    },
    adminActions: {
      padding: spacing.lg,
      paddingTop: spacing["2xl"],
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.background.border,
      marginTop: spacing.lg,
    },
    webhookButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: spacing.sm,
      backgroundColor: colors.background.surface,
      borderRadius: radii.md,
      paddingVertical: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.background.border,
    },
    webhookButtonText: {
      color: colors.purple,
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
    },
  }));
