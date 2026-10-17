import { useState } from "react";
import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import Toast from "react-native-toast-message";

import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface StageInviteBannerProps {
  invite: {
    inviterFid: number | null;
    inviterDisplayName: string | null;
    inviterPfpUrl: string | null;
    role: string;
  };
  onAccept: () => Promise<void>;
  onDecline: () => Promise<void>;
}

/**
 * Banner shown at the top of the in-app player when a host has invited
 * the local user to the stage on a Farcaster-native room.
 *
 * Surfaces what would be a Farcaster app push notification — Juke-only
 * users don't receive that push, so we poll the upstream participants
 * endpoint and render this when our own `pending_invite` field appears.
 *
 * Accept → upstream marks us as a speaker, LiveKit pushes a permission
 * change, our existing handler enables the mic.
 * Decline → upstream clears the invite; banner disappears on the next
 * poll tick.
 */
export function StageInviteBanner({
  invite,
  onAccept,
  onDecline,
}: StageInviteBannerProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);

  const inviterName =
    invite.inviterDisplayName || `fid ${invite.inviterFid ?? "?"}`;

  const handle = async (kind: "accept" | "decline") => {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === "accept") {
        await onAccept();
      } else {
        await onDecline();
      }
    } catch (e) {
      Toast.show({
        type: "error",
        text1:
          kind === "accept" ? "Couldn't accept invite" : "Couldn't decline",
        text2: "Try again — Farcaster didn't accept the response.",
      });
      setBusy(null);
    }
  };

  return (
    <View
      style={styles.container}
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${inviterName} invited you to speak`}
    >
      <View style={styles.row}>
        {invite.inviterPfpUrl ? (
          <Image
            source={{ uri: invite.inviterPfpUrl }}
            style={styles.avatar}
            contentFit="cover"
            transition={150}
          />
        ) : (
          <View style={[styles.avatar, styles.avatarFallback]}>
            <Ionicons name="mic" size={16} color={colors.text.secondary} />
          </View>
        )}
        <View style={styles.textWrap}>
          <Text style={styles.headline}>You've been invited to speak</Text>
          <Text style={styles.subhead} numberOfLines={1}>
            {inviterName} on Farcaster
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={() => void handle("decline")}
          disabled={!!busy}
          style={[styles.btn, styles.declineBtn]}
          accessibilityRole="button"
          accessibilityLabel="Decline invite"
        >
          {busy === "decline" ? (
            <ActivityIndicator color={colors.text.secondary} />
          ) : (
            <Text style={styles.declineText}>Decline</Text>
          )}
        </Pressable>
        <Pressable
          onPress={() => void handle("accept")}
          disabled={!!busy}
          style={[styles.btn, styles.acceptBtn]}
          accessibilityRole="button"
          accessibilityLabel="Accept invite"
        >
          {busy === "accept" ? (
            <ActivityIndicator color={colors.text.primary} />
          ) : (
            <Text style={styles.acceptText}>Accept</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 12,
      marginHorizontal: 16,
      marginTop: 8,
      padding: 12,
      borderRadius: 12,
      backgroundColor: "rgba(133, 93, 205, 0.16)",
      borderWidth: 1,
      borderColor: "rgba(133, 93, 205, 0.45)",
    },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 10,
      flexShrink: 1,
    },
    avatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.background.subtle,
    },
    avatarFallback: {
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    textWrap: {
      flex: 1,
      minWidth: 0,
    },
    headline: {
      color: colors.text.primary,
      fontSize: 13,
      fontWeight: "700" as const,
    },
    subhead: {
      color: colors.text.secondary,
      fontSize: 12,
      marginTop: 1,
    },
    actions: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    btn: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      minWidth: 64,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    declineBtn: {
      backgroundColor: "transparent",
      borderWidth: 1,
      borderColor: colors.background.border,
    },
    acceptBtn: {
      backgroundColor: colors.purple,
    },
    declineText: {
      color: colors.text.secondary,
      fontSize: 12,
      fontWeight: "600" as const,
    },
    acceptText: {
      color: colors.text.primary,
      fontSize: 12,
      fontWeight: "700" as const,
    },
  }));
