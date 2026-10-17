import { Pressable } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/hooks/useTheme";

/** New-message button for the Messages tab header. */
export function NewMessageButton() {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push("/messages/new")}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="New message"
      testID="messages-new-button"
    >
      <Ionicons name="create-outline" size={23} color={colors.text.primary} />
    </Pressable>
  );
}
