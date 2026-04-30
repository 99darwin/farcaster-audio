import { View, Text } from "react-native";
import { Image } from "expo-image";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface AvatarProps {
  pfpUrl: string | null;
  displayName: string;
  size?: "sm" | "md" | "lg";
  isLive?: boolean;
}

const SIZES = {
  sm: 32,
  md: 48,
  lg: 64,
};

const FONT_SIZES = {
  sm: 12,
  md: 16,
  lg: 22,
};

export function Avatar({
  pfpUrl,
  displayName,
  size = "md",
  isLive = false,
}: AvatarProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const liveRingColor = colors.accent;
  const dimension = SIZES[size];
  const fontSize = FONT_SIZES[size];
  const initials = (displayName ?? "?")
    .split(" ")
    .filter(Boolean)
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <View
      accessibilityLabel={`${displayName}'s avatar`}
      accessibilityRole="image"
      style={[
        styles.container,
        {
          width: dimension + (isLive ? 6 : 0),
          height: dimension + (isLive ? 6 : 0),
          borderRadius: (dimension + (isLive ? 6 : 0)) / 2,
          borderWidth: isLive ? 3 : 0,
          borderColor: isLive ? liveRingColor : "transparent",
        },
      ]}
    >
      {pfpUrl ? (
        <Image
          source={{ uri: pfpUrl }}
          style={{
            width: dimension,
            height: dimension,
            borderRadius: dimension / 2,
          }}
          contentFit="cover"
          cachePolicy="memory-disk"
        />
      ) : (
        <View
          style={[
            styles.fallback,
            {
              width: dimension,
              height: dimension,
              borderRadius: dimension / 2,
            },
          ]}
        >
          <Text style={[styles.initials, { fontSize }]}>{initials}</Text>
        </View>
      )}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      justifyContent: "center",
      alignItems: "center",
    },
    fallback: {
      backgroundColor: colors.background.border,
      justifyContent: "center",
      alignItems: "center",
    },
    initials: {
      color: colors.text.primary,
      fontWeight: "600",
    },
  }));
