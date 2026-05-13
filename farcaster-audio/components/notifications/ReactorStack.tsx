import { useState, type JSX } from "react";
import { View, Text, Pressable } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import type { NeynarCastAuthor } from "@/types/neynar";

interface ReactorStackProps {
  users: NeynarCastAuthor[];
  maxVisible?: number;
  size?: number;
  ringColor?: string;
}

interface ReactorPfpProps {
  user: NeynarCastAuthor;
  size: number;
  ringColor: string;
  marginLeft: number;
  zIndex: number;
  fallbackBackground: string;
  fallbackTextColor: string;
}

function ReactorPfp({
  user,
  size,
  ringColor,
  marginLeft,
  zIndex,
  fallbackBackground,
  fallbackTextColor,
}: ReactorPfpProps): JSX.Element {
  const router = useRouter();
  const [hasError, setHasError] = useState(false);
  const accessibilityLabel = user.display_name || user.username;
  const initial = (user.display_name || user.username || "?")
    .trim()
    .charAt(0)
    .toUpperCase();

  const showFallback = !user.pfp_url || hasError;

  const dimension = size;
  const borderWidth = 2;
  const outerDimension = dimension + borderWidth * 2;

  const handlePress = () => {
    router.push(`/profile/${user.fid}`);
  };

  return (
    <Pressable
      onPress={handlePress}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      style={{
        marginLeft,
        zIndex,
        width: outerDimension,
        height: outerDimension,
        borderRadius: outerDimension / 2,
        borderWidth,
        borderColor: ringColor,
        overflow: "hidden",
        justifyContent: "center",
        alignItems: "center",
      }}
    >
      {showFallback ? (
        <View
          style={{
            width: dimension,
            height: dimension,
            borderRadius: dimension / 2,
            backgroundColor: fallbackBackground,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text
            style={{
              color: fallbackTextColor,
              fontSize: Math.max(10, Math.floor(dimension * 0.5)),
              fontWeight: "600",
            }}
          >
            {initial}
          </Text>
        </View>
      ) : (
        <Image
          source={{ uri: user.pfp_url ?? undefined }}
          style={{
            width: dimension,
            height: dimension,
            borderRadius: dimension / 2,
          }}
          contentFit="cover"
          cachePolicy="memory-disk"
          onError={() => setHasError(true)}
        />
      )}
    </Pressable>
  );
}

export function ReactorStack({
  users,
  maxVisible = 6,
  size = 24,
  ringColor,
}: ReactorStackProps): JSX.Element | null {
  const { colors } = useTheme();

  if (users.length === 0) return null;

  const visible = users.slice(0, maxVisible);
  const resolvedRingColor = ringColor ?? colors.background.main;
  const overlapMargin = Math.round(-(size * 0.35));
  const fallbackBackground = colors.background.border;
  const fallbackTextColor = "#FFFFFF";

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      {visible.map((user, index) => (
        <ReactorPfp
          key={`${user.fid}-${index}`}
          user={user}
          size={size}
          ringColor={resolvedRingColor}
          marginLeft={index === 0 ? 0 : overlapMargin}
          zIndex={maxVisible - index}
          fallbackBackground={fallbackBackground}
          fallbackTextColor={fallbackTextColor}
        />
      ))}
    </View>
  );
}
