import { View, ActivityIndicator } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface LoadingSpinnerProps {
  size?: "small" | "large";
  color?: string;
  fullScreen?: boolean;
}

export function LoadingSpinner({
  size = "large",
  color,
  fullScreen = false,
}: LoadingSpinnerProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const resolvedColor = color ?? colors.accent;

  if (fullScreen) {
    return (
      <View
        style={styles.fullScreen}
        accessibilityLabel="Loading"
        accessibilityRole="progressbar"
      >
        <ActivityIndicator size={size} color={resolvedColor} />
      </View>
    );
  }

  return (
    <View accessibilityLabel="Loading" accessibilityRole="progressbar">
      <ActivityIndicator size={size} color={resolvedColor} />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    fullScreen: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: colors.background.main,
    },
  }));
