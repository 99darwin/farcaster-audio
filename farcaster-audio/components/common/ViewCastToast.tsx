import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import Toast from "react-native-toast-message";
import { colors } from "@/constants/theme";

interface ViewCastToastProps {
  hash: string;
  parentHash?: string;
}

// Cast hashes are 20-byte hex strings prefixed with `0x`. Anything else
// (including values containing `?`, `/`, or other URL-special chars) is
// rejected before being interpolated into a router.push path — a malformed
// hash could otherwise collapse params or navigate to a different route.
const isValidCastHash = (hash: string): boolean =>
  /^0x[0-9a-fA-F]{40}$/.test(hash);

export function ViewCastToast({ props }: { props: ViewCastToastProps }) {
  const router = useRouter();
  const { hash, parentHash } = props;

  const handleView = () => {
    if (!isValidCastHash(hash)) {
      Toast.hide();
      return;
    }
    if (parentHash !== undefined) {
      if (!isValidCastHash(parentHash)) {
        Toast.hide();
        return;
      }
      router.push(`/cast/${parentHash}?focusHash=${hash}`);
    } else {
      router.push(`/cast/${hash}`);
    }
    Toast.hide();
  };

  const handleDismiss = () => {
    Toast.hide();
  };

  return (
    <Pressable
      onPress={handleDismiss}
      style={styles.container}
      accessibilityRole="alert"
    >
      <View style={styles.left}>
        <Ionicons name="checkmark-circle" size={20} color={colors.success} />
        <Text style={styles.label}>Cast posted</Text>
      </View>
      <Pressable
        onPress={handleView}
        hitSlop={12}
        style={styles.viewButton}
        accessibilityRole="button"
        accessibilityLabel="View cast"
      >
        <Text style={styles.viewText}>View</Text>
      </Pressable>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: colors.background.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.background.border,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginHorizontal: 16,
    gap: 12,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 6,
  },
  left: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 1,
  },
  label: {
    color: colors.text.primary,
    fontSize: 15,
    fontWeight: "600",
  },
  viewButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: colors.purple,
  },
  viewText: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: "700",
  },
});
