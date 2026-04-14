import { View, StyleSheet, type ViewStyle, type StyleProp } from "react-native";
import { glass } from "@/constants/theme";

interface GlassViewProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  overlayColor?: string;
}

export function GlassView({
  children,
  style,
  overlayColor = glass.overlayColor,
}: GlassViewProps) {
  const flatStyle = StyleSheet.flatten(style) as ViewStyle | undefined;
  const borderRadius = flatStyle?.borderRadius;

  return (
    <View
      style={[
        {
          shadowColor: glass.shadow.color,
          shadowOffset: glass.shadow.offset,
          shadowOpacity: glass.shadow.opacity,
          shadowRadius: glass.shadow.radius,
        },
        style,
      ]}
    >
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            overflow: "hidden",
            borderRadius,
            backgroundColor: overlayColor,
            borderWidth: 1,
            borderColor: glass.borderColor,
          },
        ]}
      />
      {children}
    </View>
  );
}
