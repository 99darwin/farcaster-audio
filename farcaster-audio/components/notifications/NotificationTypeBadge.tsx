import React from "react";
import { StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/constants/theme";
import type { NotificationType } from "@/types/neynar";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

export const TYPE_META: Record<
  NotificationType,
  { icon: IconName; color: string }
> = {
  likes: { icon: "heart", color: colors.error },
  recasts: { icon: "repeat", color: colors.success },
  follows: { icon: "person-add", color: colors.purple },
  reply: { icon: "chatbubble", color: colors.info },
  mention: { icon: "at", color: colors.accent },
  quote: { icon: "chatbox-ellipses", color: colors.warning },
};

interface NotificationTypeBadgeProps {
  type: NotificationType;
  ringColor: string;
}

export const NotificationTypeBadge = ({
  type,
  ringColor,
}: NotificationTypeBadgeProps) => {
  const meta = TYPE_META[type];
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
