import { View, Text, Pressable } from "react-native";
import { useState, useCallback } from "react";
import { Ionicons } from "@expo/vector-icons";
import { Avatar } from "@/components/common/Avatar";
import { useAvatarPosition } from "@/contexts/AvatarPositionContext";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { Participant } from "@/types/space";

interface ListenerListProps {
  listeners: Participant[];
  onParticipantPress?: (participant: Participant) => void;
}

const COLLAPSED_COUNT = 14;

export function ListenerList({
  listeners,
  onParticipantPress,
}: ListenerListProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [isExpanded, setIsExpanded] = useState(false);
  const { register } = useAvatarPosition();
  const visibleListeners = isExpanded
    ? listeners
    : listeners.slice(0, COLLAPSED_COUNT);

  const handleRef = useCallback(
    (fid: number, ref: View | null) => {
      if (ref) register(fid, ref);
    },
    [register],
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Listeners ({listeners.length})</Text>
      <View style={styles.grid}>
        {visibleListeners.map((listener) => (
          <Pressable
            key={listener.fid}
            ref={(ref) => handleRef(listener.fid, ref)}
            style={styles.listenerItem}
            accessibilityLabel={
              listener.hand_raised
                ? `${listener.display_name} — hand raised`
                : listener.display_name
            }
            accessibilityRole="button"
            accessibilityHint="Tap to view profile"
            onPress={() => onParticipantPress?.(listener)}
          >
            <View style={styles.avatarWrap}>
              <Avatar
                pfpUrl={listener.pfp_url}
                displayName={listener.display_name}
                size="sm"
              />
              {listener.hand_raised && (
                <View style={styles.handBadge}>
                  <Ionicons
                    name="hand-left"
                    size={10}
                    color={colors.background.main}
                  />
                </View>
              )}
            </View>
          </Pressable>
        ))}
      </View>
      {listeners.length > COLLAPSED_COUNT && (
        <Pressable
          onPress={() => setIsExpanded(!isExpanded)}
          style={styles.toggleButton}
          accessibilityLabel={
            isExpanded
              ? "Show fewer listeners"
              : `Show all ${listeners.length} listeners`
          }
          accessibilityRole="button"
        >
          <Text style={styles.toggleText}>
            {isExpanded ? "Show less" : `Show all ${listeners.length}`}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: { padding: 16, paddingTop: 0 },
    title: {
      color: colors.text.secondary,
      fontSize: 13,
      fontWeight: "600",
      textTransform: "uppercase",
      marginBottom: 12,
    },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    listenerItem: { alignItems: "center" },
    avatarWrap: { position: "relative" },
    handBadge: {
      position: "absolute",
      bottom: -2,
      right: -2,
      width: 16,
      height: 16,
      borderRadius: 8,
      backgroundColor: colors.accent,
      alignItems: "center",
      justifyContent: "center",
    },
    toggleButton: {
      minHeight: 44,
      justifyContent: "center",
      alignItems: "center",
      marginTop: 4,
    },
    toggleText: { color: colors.accent, fontSize: 14, textAlign: "center" },
  }));
