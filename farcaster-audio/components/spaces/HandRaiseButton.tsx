import { Pressable, Text } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface HandRaiseButtonProps {
  isRaised: boolean;
  onPress: () => void;
  disabled?: boolean;
}

export function HandRaiseButton({
  isRaised,
  onPress,
  disabled = false,
}: HandRaiseButtonProps) {
  const { colors } = useTheme();
  const styles = useStyles();

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      accessibilityLabel={isRaised ? "Lower hand" : "Raise hand"}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        isRaised && styles.raisedButton,
        { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 },
      ]}
    >
      <Ionicons name="hand-left" size={20} color={colors.text.primary} />
      <Text style={[styles.text, isRaised && styles.raisedText]}>
        {isRaised ? "Lower hand" : "Raise hand"}
      </Text>
    </Pressable>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    button: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: colors.background.border,
      paddingVertical: 12,
      paddingHorizontal: 20,
      borderRadius: 24,
    },
    raisedButton: {
      backgroundColor: colors.accent,
    },
    text: { color: colors.text.primary, fontSize: 15, fontWeight: "600" },
    raisedText: { color: colors.text.primary },
  }));
