/**
 * Native-room host control screen.
 *
 * Secondary landing surface for the host of a Farcaster-native room.
 * The create flow now routes the host straight into `/space/{id}`
 * (where they join the upstream LiveKit room and host in-app), so this
 * screen is reached only via direct deep-link / notification handoff.
 *
 *   - "Open on Farcaster" — deep-links to the upstream room page (fallback
 *     for users who prefer the web client).
 *   - "End Space" — calls Juke's authenticated end endpoint, which
 *     dispatches `audio-room/end` upstream.
 *   - "Done" — leaves the room running, returns to home.
 *
 * Status-aware: when the room is already ended, only the "Done" CTA
 * is shown.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Image,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Toast from "react-native-toast-message";

import { Button } from "@/components/common/Button";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { useAuthStore } from "@/stores/authStore";
import * as api from "@/services/api";
import { signFarcasterClientBearer } from "@/services/snapSigner";
import type { Room } from "@/types/space";

const farcasterSpaceUrl = (id: string): string =>
  `https://farcaster.xyz/~/spaces/${encodeURIComponent(id)}`;

type RoomState = "live" | "scheduled" | "ended" | "cancelled" | "unknown";

function deriveState(status: string): RoomState {
  if (status === "active") return "live";
  if (status === "scheduled") return "scheduled";
  if (status === "ended") return "ended";
  if (status === "cancelled") return "cancelled";
  return "unknown";
}

function HostScreenContent({
  room,
  hostUsername,
  onEnd,
  isEnding,
  onOpenFarcaster,
}: {
  room: Room;
  hostUsername: string;
  onEnd: () => void;
  isEnding: boolean;
  onOpenFarcaster: () => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const state = deriveState(room.status);
  const isFinal = state === "ended" || state === "cancelled";

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.replace("/")}
          accessibilityLabel="Back to home"
          accessibilityRole="button"
          style={styles.backBtn}
        >
          <Ionicons name="chevron-back" size={24} color={colors.text.primary} />
        </Pressable>
        <Text style={styles.headerTitle}>Your space</Text>
        <View style={styles.backBtn} />
      </View>

      <View style={styles.content}>
        <View style={styles.avatarWrap}>
          {room.host.pfp_url ? (
            <Image
              source={{ uri: room.host.pfp_url }}
              style={styles.avatar}
            />
          ) : (
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(room.host.display_name || hostUsername || "?")[0].toUpperCase()}
              </Text>
            </View>
          )}
        </View>

        <Text style={styles.title} accessibilityRole="header">
          {room.title}
        </Text>

        <Text style={styles.hostedBy}>
          Hosted on Farcaster as @{hostUsername}
        </Text>

        <View
          style={[
            styles.statePill,
            state === "live" && styles.statePillLive,
            state === "scheduled" && styles.statePillScheduled,
            isFinal && styles.statePillEnded,
          ]}
          accessibilityLabel={`Space state: ${state}`}
        >
          {state === "live" && <View style={styles.liveDot} />}
          <Text
            style={[
              styles.statePillText,
              state === "live" && styles.statePillTextLive,
              state === "scheduled" && styles.statePillTextScheduled,
              isFinal && styles.statePillTextEnded,
            ]}
          >
            {state === "live"
              ? "Live"
              : state === "scheduled"
                ? "Scheduled"
                : state === "ended"
                  ? "Ended"
                  : state === "cancelled"
                    ? "Cancelled"
                    : "Unknown"}
          </Text>
        </View>

        <View style={[styles.actions, { paddingBottom: insets.bottom + 24 }]}>
          {!isFinal && (
            <>
              <Button
                title="Open on Farcaster"
                onPress={onOpenFarcaster}
                size="lg"
                accessibilityLabel="Open this space on Farcaster"
              />
              <Pressable
                onPress={onEnd}
                disabled={isEnding}
                style={styles.endBtn}
                accessibilityRole="button"
                accessibilityLabel="End this space"
              >
                <Ionicons
                  name="stop-circle-outline"
                  size={18}
                  color={colors.error}
                />
                <Text style={styles.endBtnText}>
                  {isEnding ? "Ending..." : "End Space"}
                </Text>
              </Pressable>
            </>
          )}

          <Pressable
            onPress={() => router.replace("/")}
            style={styles.doneBtn}
            accessibilityRole="button"
            accessibilityLabel="Done"
          >
            <Text style={styles.doneBtnText}>Done</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export default function HostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [room, setRoom] = useState<Room | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isEnding, setIsEnding] = useState(false);

  // Fetch the Juke Room. We can't skip this and rely on store state
  // because `router.replace` from the create screen wipes the
  // intermediate component — the host might also deep-link straight
  // here from a notification.
  useEffect(() => {
    if (!id) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    api
      .getRoom(id)
      .then((detail) => {
        if (cancelled) return;
        setRoom(detail.room);
      })
      .catch((err) => {
        if (cancelled) return;
        Toast.show({
          type: "error",
          text1: "Couldn't load space",
          text2: api.getErrorMessage(err),
        });
        router.replace("/");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id, router]);

  const hostUsername: string =
    (room?.host as { username?: string } | undefined)?.username ??
    user?.username ??
    "host";

  const handleOpenFarcaster = useCallback(async () => {
    if (!room) return;
    const targetId = room.farcaster_room_id ?? room.id;
    try {
      await Linking.openURL(farcasterSpaceUrl(targetId));
    } catch {
      Toast.show({
        type: "error",
        text1: "Couldn't open Farcaster",
        text2: "Make sure the Farcaster app or a browser is available.",
      });
    }
  }, [room]);

  const handleEnd = useCallback(() => {
    if (!id || !room) return;
    Alert.alert(
      "End this Space?",
      "Listeners will be disconnected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "End Space",
          style: "destructive",
          onPress: async () => {
            setIsEnding(true);
            try {
              // User-FID native rooms (the default) need the user's
              // own JFS bearer to authorize the upstream end — service
              // bearer 403s. Sign on-device and forward through Juke.
              // Service-FID rooms ignore the bearer; harmless to send.
              const myFid = user?.fid;
              const userBearer = myFid
                ? await signFarcasterClientBearer(myFid)
                : undefined;
              await api.endFarcasterNativeRoom(id, {
                user_jfs_bearer: userBearer,
              });
              Toast.show({
                type: "success",
                text1: "Space ended",
              });
              router.replace("/");
            } catch (err) {
              Toast.show({
                type: "error",
                text1: "Couldn't end space",
                text2: api.getErrorMessage(err),
              });
              setIsEnding(false);
            }
          },
        },
      ],
    );
  }, [id, room, router, user?.fid]);

  if (isLoading || !room) {
    return <LoadingSpinner fullScreen />;
  }

  return (
    <HostScreenContent
      room={room}
      hostUsername={hostUsername}
      onEnd={handleEnd}
      isEnding={isEnding}
      onOpenFarcaster={handleOpenFarcaster}
    />
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
    },
    header: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    backBtn: {
      width: 44,
      height: 44,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    headerTitle: {
      color: colors.text.primary,
      fontSize: 17,
      fontWeight: "600" as const,
    },
    content: {
      flex: 1,
      paddingHorizontal: 32,
      alignItems: "center" as const,
      justifyContent: "flex-start" as const,
      paddingTop: 24,
    },
    avatarWrap: {
      marginBottom: 24,
    },
    avatar: {
      width: 96,
      height: 96,
      borderRadius: 48,
      backgroundColor: colors.background.surface,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderWidth: 2,
      borderColor: colors.background.border,
    },
    avatarText: {
      color: colors.text.primary,
      fontSize: 36,
      fontWeight: "700" as const,
    },
    title: {
      color: colors.text.primary,
      fontSize: 26,
      fontWeight: "700" as const,
      textAlign: "center" as const,
      marginBottom: 8,
    },
    hostedBy: {
      color: colors.text.secondary,
      fontSize: 15,
      marginBottom: 20,
      textAlign: "center" as const,
    },
    statePill: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 999,
      backgroundColor: colors.background.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.background.border,
      marginBottom: 40,
    },
    statePillLive: {
      backgroundColor: "rgba(255, 59, 48, 0.12)",
      borderColor: "rgba(255, 59, 48, 0.32)",
    },
    statePillScheduled: {
      backgroundColor: "rgba(216, 90, 48, 0.12)",
      borderColor: "rgba(216, 90, 48, 0.32)",
    },
    statePillEnded: {
      backgroundColor: colors.background.subtle,
      borderColor: colors.background.border,
    },
    liveDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.live,
    },
    statePillText: {
      color: colors.text.primary,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    statePillTextLive: {
      color: colors.error,
    },
    statePillTextScheduled: {
      color: colors.accent,
    },
    statePillTextEnded: {
      color: colors.text.secondary,
    },
    actions: {
      width: "100%" as const,
      marginTop: "auto" as const,
      gap: 16,
    },
    endBtn: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 8,
      minHeight: 44,
      paddingVertical: 12,
    },
    endBtnText: {
      color: colors.error,
      fontSize: 16,
      fontWeight: "600" as const,
    },
    doneBtn: {
      alignItems: "center" as const,
      justifyContent: "center" as const,
      minHeight: 44,
      paddingVertical: 12,
    },
    doneBtnText: {
      color: colors.text.secondary,
      fontSize: 16,
      fontWeight: "500" as const,
    },
  }));
