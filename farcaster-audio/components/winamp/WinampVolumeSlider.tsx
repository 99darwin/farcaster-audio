import React, { memo } from "react";
import { View, Text, StyleSheet } from "react-native";
import { WINAMP, PANEL_MARGIN } from "./winampTheme";

export const WinampVolumeSlider = memo(function WinampVolumeSlider() {
  const value = 0.75;
  const segments = 28;
  const activeSegments = Math.floor(value * segments);

  return (
    <View
      style={styles.container}
      accessibilityRole="adjustable"
      accessibilityLabel="Volume"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100) }}
    >
      <Text style={styles.label}>VOL</Text>
      <View style={styles.trackOuter}>
        <View style={styles.track}>
          {Array.from({ length: segments }).map((_, i) => {
            const isActive = i < activeSegments;
            const ratio = i / segments;
            let color: string = WINAMP.visualizer.barLow;
            if (ratio > 0.8) color = WINAMP.accent.red;
            else if (ratio > 0.6) color = WINAMP.accent.cyan;
            else if (ratio > 0.3) color = WINAMP.visualizer.barMid;
            return (
              <View
                key={i}
                style={[
                  styles.segment,
                  { backgroundColor: isActive ? color : WINAMP.bevel.dark },
                ]}
              />
            );
          })}
        </View>
      </View>
      {/* Thumb */}
      <View style={[styles.thumbTrack, { width: `${value * 80 + 10}%` }]}>
        <View style={styles.thumb}>
          <View style={styles.thumbGroove} />
          <View style={styles.thumbGroove} />
          <View style={styles.thumbGroove} />
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 4,
  },
  label: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 6,
    color: WINAMP.lcd.textDim,
    width: 22,
  },
  trackOuter: {
    flex: 1,
    backgroundColor: WINAMP.lcd.bg,
    borderWidth: 1,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.mid,
    borderRightColor: WINAMP.bevel.mid,
    padding: 2,
    height: 12,
  },
  track: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
    gap: 1,
  },
  segment: {
    flex: 1,
    borderRadius: 0,
  },
  thumbTrack: {
    position: "absolute",
    left: 26,
    top: 0,
    bottom: 0,
    justifyContent: "center",
    alignItems: "flex-end",
  },
  thumb: {
    width: 12,
    height: 18,
    backgroundColor: WINAMP.bevel.face,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.light,
    borderLeftColor: WINAMP.bevel.light,
    borderBottomColor: WINAMP.bevel.dark,
    borderRightColor: WINAMP.bevel.dark,
    justifyContent: "center",
    alignItems: "center",
    gap: 1,
  },
  thumbGroove: {
    width: 6,
    height: 1,
    backgroundColor: WINAMP.bevel.dark,
  },
});
