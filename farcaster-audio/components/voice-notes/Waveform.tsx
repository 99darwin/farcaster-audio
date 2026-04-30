import { View, StyleSheet } from "react-native";
import React, { useCallback, useMemo, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { useTheme } from "@/hooks/useTheme";

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
  filledColor,
  unfilledColor,
}: WaveformProps) {
  const { colors } = useTheme();
  const resolvedFilled = filledColor ?? colors.accent;
  const resolvedUnfilled = unfilledColor ?? colors.background.subtle;

  const [width, setWidth] = useState(0);

  const handleLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  const seekFromX = useCallback(
    (x: number) => {
      if (!onSeek || !width) return;
      onSeek(Math.max(0, Math.min(1, x / width)));
    },
    [onSeek, width],
  );

  const barHeights = useMemo(() => {
    if (peaks.length === 0) return [];
    const targetCount =
      width > 0 ? Math.min(96, Math.max(32, Math.floor(width / 3))) : 64;
    if (peaks.length <= targetCount) {
      return peaks.map((peak) => Math.max(2, peak * height));
    }
    const bucketSize = peaks.length / targetCount;
    return Array.from({ length: targetCount }, (_, i) => {
      const start = Math.floor(i * bucketSize);
      const end = Math.max(start + 1, Math.floor((i + 1) * bucketSize));
      let max = 0;
      for (let j = start; j < end && j < peaks.length; j++) {
        max = Math.max(max, peaks[j]);
      }
      return Math.max(2, max * height);
    });
  }, [peaks, height, width]);

  const barCount = barHeights.length || 1;
  const filledIndex = Math.floor(progress * barCount);
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onBegin((event) => {
          runOnJS(seekFromX)(event.x);
        })
        .onUpdate((event) => {
          runOnJS(seekFromX)(event.x);
        }),
    [seekFromX],
  );

  return (
    <GestureDetector gesture={panGesture}>
      <View
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
                backgroundColor:
                  i <= filledIndex ? resolvedFilled : resolvedUnfilled,
              },
            ]}
          />
        ))}
      </View>
    </GestureDetector>
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
