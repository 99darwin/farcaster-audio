import {
  View,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/constants/theme";

interface UpdateBannerProps {
  isRestarting: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}

export function UpdateBanner({
  isRestarting,
  onUpdate,
  onDismiss,
}: UpdateBannerProps) {
  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Ionicons
          name="arrow-down-circle-outline"
          size={18}
          color={colors.text.primary}
        />
        <Text style={styles.text}>A new update is available</Text>
      </View>
      <View style={styles.actions}>
        {isRestarting ? (
          <ActivityIndicator size="small" color={colors.text.primary} />
        ) : (
          <>
            <Pressable
              onPress={onUpdate}
              style={styles.updateButton}
              hitSlop={8}
            >
              <Text style={styles.updateText}>Update</Text>
            </Pressable>
            <Pressable onPress={onDismiss} hitSlop={8}>
              <Ionicons name="close" size={18} color={colors.text.secondary} />
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
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
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: "500",
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  updateButton: {
    backgroundColor: "rgba(255,255,255,0.2)",
    paddingHorizontal: 14,
    paddingVertical: 5,
    borderRadius: 14,
  },
  updateText: {
    color: colors.text.primary,
    fontSize: 13,
    fontWeight: "700",
  },
});
