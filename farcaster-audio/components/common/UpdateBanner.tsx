import { useState } from "react";
import { View, Text, Pressable, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface UpdateBannerProps {
  isRestarting: boolean;
  onUpdate: () => void | Promise<void>;
  onDismiss: () => void;
}

const RESTART_ERROR = "Couldn't restart to apply the update. Try again.";
const BANNER_FOREGROUND = "#fff";

export function UpdateBanner({
  isRestarting,
  onUpdate,
  onDismiss,
}: UpdateBannerProps) {
  const styles = useStyles();
  const [actionError, setActionError] = useState<string | null>(null);

  const handleUpdate = async () => {
    setActionError(null);
    try {
      await onUpdate();
    } catch {
      setActionError(RESTART_ERROR);
    }
  };

  return (
    <View style={styles.container} accessibilityLiveRegion="polite">
      <View style={styles.content}>
        <Ionicons
          name="arrow-down-circle-outline"
          size={18}
          color={BANNER_FOREGROUND}
          accessible={false}
          importantForAccessibility="no-hide-descendants"
        />
        <Text style={[styles.text, actionError && styles.errorText]}>
          {actionError ??
            (isRestarting
              ? "Restarting to apply update…"
              : "Update downloaded and ready")}
        </Text>
      </View>
      <View style={styles.actions}>
        {isRestarting ? (
          <ActivityIndicator
            size="small"
            color={BANNER_FOREGROUND}
            accessibilityLabel="Restarting to apply update"
          />
        ) : (
          <>
            <Pressable
              onPress={() => void handleUpdate()}
              style={styles.updateButton}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={
                actionError ? "Retry update restart" : "Restart to update"
              }
            >
              <Text style={styles.updateText}>
                {actionError ? "Retry" : "Restart"}
              </Text>
            </Pressable>
            <Pressable
              onPress={onDismiss}
              hitSlop={8}
              style={styles.dismissButton}
              accessibilityRole="button"
              accessibilityLabel="Dismiss update"
            >
              <Ionicons
                name="close"
                size={18}
                color={BANNER_FOREGROUND}
                accessible={false}
                importantForAccessibility="no-hide-descendants"
              />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors, glass }) => ({
    container: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      backgroundColor: colors.purple,
      paddingHorizontal: 16,
      paddingVertical: 10,
    },
    content: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flex: 1,
    },
    text: {
      flexShrink: 1,
      color: BANNER_FOREGROUND,
      fontSize: 14,
      fontWeight: "500",
    },
    errorText: {
      color: BANNER_FOREGROUND,
      fontWeight: "600",
    },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    updateButton: {
      minHeight: 44,
      justifyContent: "center",
      backgroundColor: glass.accentOverlay,
      paddingHorizontal: 14,
      borderRadius: 22,
    },
    updateText: {
      color: BANNER_FOREGROUND,
      fontSize: 13,
      fontWeight: "700",
    },
    dismissButton: {
      minWidth: 44,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
    },
  }));
