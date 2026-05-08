import { View, Text, Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSpaceStore } from "@/stores/spaceStore";
import { GlassView } from "@/components/common/GlassView";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface SpaceMiniBarProps {
  onToggleMute: () => void;
  onLeave: () => void;
  bottomOffset?: number;
}

export function SpaceMiniBar({
  onToggleMute,
  onLeave,
  bottomOffset = 0,
}: SpaceMiniBarProps) {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useStyles();
  const room = useSpaceStore((s) => s.room);
  const isMuted = useSpaceStore((s) => s.isMuted);
  const isConnected = useSpaceStore((s) => s.isConnected);

  if (!room) return null;

  return (
    <GlassView style={[styles.container, { bottom: bottomOffset }]}>
      <Pressable
        style={styles.content}
        onPress={() => router.push(`/space/${room.id}`)}
        accessibilityLabel={`Active space: ${room.title}`}
        accessibilityRole="button"
      >
        <View style={styles.leftSection}>
          <View style={styles.liveDot} />
          <Text style={styles.title} numberOfLines={1}>
            {room.title}
          </Text>
          {!isConnected && (
            <Text style={styles.reconnecting}>Reconnecting...</Text>
          )}
        </View>
        <View style={styles.controls}>
          <Pressable
            onPress={onToggleMute}
            style={styles.controlButton}
            accessibilityLabel={
              isMuted ? "Unmute microphone" : "Mute microphone"
            }
            accessibilityRole="button"
          >
            <Ionicons
              name={isMuted ? "mic-off" : "mic"}
              size={18}
              color={colors.text.primary}
            />
          </Pressable>
          <View style={styles.divider} />
          <Pressable
            onPress={onLeave}
            style={styles.controlButton}
            accessibilityLabel="Leave space"
            accessibilityRole="button"
          >
            <Ionicons name="exit-outline" size={18} color={colors.error} />
          </Pressable>
        </View>
      </Pressable>
    </GlassView>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors, glass }) => ({
    container: {
      position: "absolute",
      left: 0,
      right: 0,
      marginHorizontal: 12,
      borderRadius: glass.capsuleRadius,
    },
    content: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    leftSection: {
      flexDirection: "row",
      alignItems: "center",
      flex: 1,
      gap: 8,
    },
    liveDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.live,
    },
    title: {
      color: colors.text.primary,
      fontSize: 14,
      fontWeight: "600",
      flexShrink: 1,
    },
    reconnecting: { color: colors.warning, fontSize: 12 },
    controls: { flexDirection: "row", alignItems: "center", gap: 4 },
    controlButton: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 10,
      paddingVertical: 8,
      minWidth: 44,
      minHeight: 44,
    },
    divider: {
      width: 1,
      height: 20,
      backgroundColor: glass.borderColor,
    },
  }));
