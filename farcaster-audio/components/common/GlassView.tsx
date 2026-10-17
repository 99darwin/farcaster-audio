import { useEffect, useState } from "react";
import {
  AccessibilityInfo,
  View,
  StyleSheet,
  type ViewStyle,
  type StyleProp,
} from "react-native";
import { BlurView } from "expo-blur";
import { useTheme } from "@/hooks/useTheme";

interface GlassViewProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  overlayColor?: string;
  blurIntensity?: number;
  tint?: "light" | "dark" | "default";
  testID?: string;
}

export function GlassView({
  children,
  style,
  overlayColor,
  blurIntensity,
  tint,
  testID,
}: GlassViewProps) {
  const { glass } = useTheme();
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const flatStyle = StyleSheet.flatten(style) as ViewStyle | undefined;
  const borderRadius = flatStyle?.borderRadius;
  const resolvedOverlay = overlayColor ?? glass.overlayColor;
  const resolvedBlurIntensity = blurIntensity ?? glass.blurIntensity;
  const resolvedTint = tint ?? glass.tint;

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceTransparencyEnabled()
      .then((enabled) => {
        if (mounted) setReduceTransparency(enabled);
      })
      .catch(() => {
        // Some Android accessibility implementations do not expose this
        // setting. The normal translucent fallback remains safe/readable.
      });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setReduceTransparency,
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return (
    <View
      testID={testID}
      style={[
        {
          shadowColor: glass.shadow.color,
          shadowOffset: glass.shadow.offset,
          shadowOpacity: glass.shadow.opacity,
          shadowRadius: glass.shadow.radius,
          elevation: 10,
        },
        style,
      ]}
    >
      <View
        testID="glass-backdrop"
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            overflow: "hidden",
            borderRadius,
            borderWidth: 1,
            borderColor: glass.borderColor,
          },
        ]}
      >
        {!reduceTransparency ? (
          <BlurView
            testID="glass-blur"
            pointerEvents="none"
            tint={resolvedTint}
            intensity={resolvedBlurIntensity}
            blurMethod="dimezisBlurViewSdk31Plus"
            blurReductionFactor={4}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <View
          testID="glass-translucent-overlay"
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: resolvedOverlay }]}
        />
        {reduceTransparency ? (
          <View
            testID="glass-reduced-transparency-boost"
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: resolvedOverlay },
            ]}
          />
        ) : null}
        <View
          testID="glass-highlight"
          pointerEvents="none"
          style={styles.highlight}
        />
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  highlight: {
    position: "absolute",
    top: 1,
    left: 18,
    right: 18,
    height: StyleSheet.hairlineWidth,
    backgroundColor: "rgba(255,255,255,0.22)",
  },
});
