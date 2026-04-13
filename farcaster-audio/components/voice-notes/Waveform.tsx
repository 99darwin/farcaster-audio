import { View, Pressable, StyleSheet } from "react-native";
import React, { useCallback, useMemo, useState } from "react";
import type { LayoutChangeEvent, GestureResponderEvent } from "react-native";
import { colors } from "@/constants/theme";

interface WaveformProps {
  peaks: number[];
  progress: number; // 0-1
  onSeek?: (progress: number) => void;
  height?: number;
  filledColor?: string;
  unfilledColor?: string;
}

export const Waveform = React.memo(function Waveform({
  peaks,
  progress,
  onSeek,
  height = 48,
  filledColor = colors.accent,
  unfilledColor = colors.background.subtle,
}: WaveformProps) {
  const [width, setWidth] = useState(0);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  const handlePress = useCallback(
    (e: GestureResponderEvent) => {
      if (!onSeek || !width) return;
      const x = e.nativeEvent.locationX;
      onSeek(Math.max(0, Math.min(1, x / width)));
    },
    [onSeek, width],
  );

  // Memoize bar heights so they don't recompute when only progress changes
  const barHeights = useMemo(
    () => peaks.map((peak) => Math.max(2, peak * height)),
    [peaks, height],
  );

  const barCount = peaks.length || 200;
  const filledIndex = Math.floor(progress * barCount);

  return (
    <Pressable
      onPress={handlePress}
      onLayout={handleLayout}
      style={[styles.container, { height }]}
      accessibilityLabel="Audio waveform"
      accessibilityRole="adjustable"
    >
      {barHeights.map((barHeight, i) => (
        <View
          key={i}
          style={[
            styles.bar,
            {
              height: barHeight,
              backgroundColor: i <= filledIndex ? filledColor : unfilledColor,
            },
          ]}
        />
      ))}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 1,
  },
  bar: {
    flex: 1,
    borderRadius: 1,
    minWidth: 1,
  },
});
