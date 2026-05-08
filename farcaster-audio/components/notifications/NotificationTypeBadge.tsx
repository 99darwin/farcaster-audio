import React from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import type { ThemeColors } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import type { NotificationType } from "@/types/neynar";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

export interface TypeMeta {
  icon: IconName;
  color: string;
}

export function getTypeMeta(
  type: NotificationType,
  colors: ThemeColors,
): TypeMeta {
  switch (type) {
    case "likes":
      return { icon: "heart", color: colors.error };
    case "recasts":
      return { icon: "repeat", color: colors.success };
    case "follows":
      return { icon: "person-add", color: colors.purple };
    case "reply":
      return { icon: "chatbubble", color: colors.info };
    case "mention":
      return { icon: "at", color: colors.accent };
    case "quote":
      return { icon: "chatbox-ellipses", color: colors.warning };
  }
}

interface NotificationTypeBadgeProps {
  type: NotificationType;
  ringColor: string;
}

export const NotificationTypeBadge = ({
  type,
  ringColor,
}: NotificationTypeBadgeProps) => {
  const { colors } = useTheme();
  const meta = getTypeMeta(type, colors);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.badge,
        { backgroundColor: meta.color, borderColor: ringColor },
      ]}
    >
      <Ionicons name={meta.icon} size={11} color="#ffffff" />
    </View>
  );
};

const styles = StyleSheet.create({
  badge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
});
