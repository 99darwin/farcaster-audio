import { Pressable, Text, View } from "react-native";
import { Avatar } from "@/components/common/Avatar";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { FarcasterNativeSpace } from "@/services/api";

interface FarcasterSpaceAvatarProps {
  space: FarcasterNativeSpace;
  onPress: () => void;
}

/**
 * Discovery-rail tile for a Farcaster-native audio space.
 *
 * Mirrors `SpaceAvatar`'s visual proportions so the rail reads as a
 * single sequence regardless of which platform hosts the room. The
 * "On Farcaster" chip is the only visual differentiator — the tap
 * handler routes out to farcaster.xyz instead of the in-app player
 * (Phase 0; an in-app Farcaster player ships in Phase 2).
 */
export function FarcasterSpaceAvatar({
  space,
  onPress,
}: FarcasterSpaceAvatarProps) {
  const styles = useStyles();
  const isLive = space.state === "live";
  const displayName = space.host.display_name ?? space.host.username ?? "—";
  const firstName = displayName.split(" ")[0] ?? displayName;
  const listeners = space.listener_count ?? 0;

  return (
    <Pressable
      onPress={onPress}
      style={styles.container}
      accessibilityRole="link"
      accessibilityLabel={`${space.title ?? displayName}, on Farcaster, ${
        isLive ? `${listeners} listening` : "scheduled"
      }`}
    >
      <Avatar
        pfpUrl={space.host.pfp_url ?? null}
        displayName={displayName}
        size="lg"
        isLive={isLive}
      />
      <Text style={styles.name} numberOfLines={1}>
        {firstName}
      </Text>
      <View style={styles.farcasterChip}>
        <Text style={styles.farcasterChipText}>On Farcaster</Text>
      </View>
      {isLive ? (
        <View style={styles.listenerBadge}>
          <Text style={styles.listenerCount}>{listeners}</Text>
        </View>
      ) : (
        <View style={styles.scheduledBadge}>
          <Text style={styles.scheduledIcon}>🗓</Text>
        </View>
      )}
    </Pressable>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      alignItems: "center",
      width: 72,
      marginRight: 12,
      position: "relative",
    },
    name: {
      color: colors.text.light,
      fontSize: 11,
      marginTop: 4,
      textAlign: "center",
    },
    farcasterChip: {
      marginTop: 2,
      paddingHorizontal: 6,
      paddingVertical: 1,
      borderRadius: 8,
      backgroundColor: "rgba(133, 93, 205, 0.18)",
    },
    farcasterChipText: {
      color: colors.text.secondary,
      fontSize: 9,
      fontWeight: "600",
      letterSpacing: 0.2,
    },
    listenerBadge: {
      position: "absolute",
      top: -2,
      right: 2,
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 4,
      paddingVertical: 1,
      minWidth: 16,
      alignItems: "center",
    },
    listenerCount: {
      color: colors.text.primary,
      fontSize: 10,
      fontWeight: "700",
    },
    scheduledBadge: {
      position: "absolute",
      top: -2,
      right: 2,
      backgroundColor: "rgba(133, 93, 205, 0.2)",
      borderRadius: 8,
      paddingHorizontal: 3,
      paddingVertical: 1,
      minWidth: 16,
      alignItems: "center",
    },
    scheduledIcon: { fontSize: 10 },
  }));
