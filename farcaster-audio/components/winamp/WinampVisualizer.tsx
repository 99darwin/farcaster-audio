import { useEffect, useRef, useState } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  type SharedValue,
  makeMutable,
} from 'react-native-reanimated';
import { WINAMP, PANEL_MARGIN } from './winampTheme';

const BAR_COUNT = 28;
const MAX_HEIGHT = 56;
const SEGMENT_COUNT = 16;
const SEGMENT_HEIGHT = 3;
const SEGMENT_GAP = 1;

// Pre-compute segment colors (bottom to top)
const SEGMENT_COLORS: string[] = Array.from({ length: SEGMENT_COUNT }, (_, i) => {
  const ratio = i / SEGMENT_COUNT;
  if (ratio > 0.85) return WINAMP.visualizer.barPeak;  // pink top
  if (ratio > 0.65) return WINAMP.visualizer.barHigh;   // cyan
  if (ratio > 0.35) return WINAMP.visualizer.barMid;    // purple
  return WINAMP.visualizer.barLow;                       // dark purple
});

function VisualizerBar({ barHeight, peakY }: { barHeight: SharedValue<number>; peakY: SharedValue<number> }) {
  const barStyle = useAnimatedStyle(() => ({
    height: Math.max(2, barHeight.value),
  }));

  const peakStyle = useAnimatedStyle(() => ({
    bottom: Math.min(MAX_HEIGHT - 3, Math.max(0, peakY.value)),
    opacity: peakY.value > 2 ? 1 : 0,
  }));

  return (
    <View style={styles.barContainer}>
      <Animated.View style={[styles.bar, barStyle]}>
        {SEGMENT_COLORS.map((color, i) => (
          <View key={i} style={{ height: SEGMENT_HEIGHT, backgroundColor: color, marginBottom: SEGMENT_GAP }} />
        ))}
      </Animated.View>
      {/* Peak hold dot */}
      <Animated.View style={[styles.peak, peakStyle]} />
    </View>
  );
}

function createSharedArrays() {
  return {
    barHeights: Array.from({ length: BAR_COUNT }, () => makeMutable(2)),
    peakYs: Array.from({ length: BAR_COUNT }, () => makeMutable(0)),
  };
}

export function WinampVisualizer({ activeSpeakerCount, isSpeaking }: { activeSpeakerCount: number; isSpeaking: boolean }) {
  const [isVisible, setIsVisible] = useState(true);
  const energy = useSharedValue(0.15);

  // Create mutable shared values for all bars (stable across renders)
  const { barHeights, peakYs } = useRef(createSharedArrays()).current;

  // Single interval to update all bars (~16fps)
  useEffect(() => {
    if (!isVisible) return;

    const interval = setInterval(() => {
      const now = Date.now();
      const base = energy.value;

      for (let i = 0; i < BAR_COUNT; i++) {
        // Bar height update
        const wave = Math.sin(now / 200 + i * 0.7) * 0.2;
        const jitter = Math.random() * 0.5 + 0.5;
        const targetHeight = Math.max(2, (base + wave) * jitter * MAX_HEIGHT);
        barHeights[i].value = withSpring(targetHeight, {
          damping: 6,
          stiffness: 280,
          mass: 0.3,
        });

        // Peak update
        if (targetHeight > peakYs[i].value - 2) {
          peakYs[i].value = targetHeight + 2;
        }
        // Peak decay
        peakYs[i].value = withTiming(
          Math.max(0, peakYs[i].value - 1.5),
          { duration: 80 },
        );
      }
    }, 60);

    return () => clearInterval(interval);
  }, [isVisible, energy, barHeights, peakYs]);

  useEffect(() => {
    if (activeSpeakerCount > 0) {
      const level = Math.min(1, 0.35 + activeSpeakerCount * 0.2);
      energy.value = withTiming(level, { duration: 250 });
    } else {
      energy.value = withTiming(0.12, { duration: 600 });
    }
  }, [activeSpeakerCount, energy]);

  useEffect(() => {
    if (isSpeaking) {
      energy.value = withTiming(Math.min(1, energy.value + 0.35), { duration: 150 });
    }
  }, [isSpeaking, energy]);

  if (!isVisible) {
    return (
      <Pressable onPress={() => setIsVisible(true)} style={styles.containerOff}>
        {/* Just dark screen with scanlines */}
        {Array.from({ length: 12 }).map((_, i) => (
          <View key={i} style={styles.offScanline} />
        ))}
      </Pressable>
    );
  }

  return (
    <Pressable
      onPress={() => setIsVisible(false)}
      style={styles.container}
      accessible={true}
      accessibilityLabel="Audio visualizer"
      accessibilityRole="image"
    >
      {/* Scanline overlay */}
      <View style={styles.scanlineOverlay} accessible={false}>
        {Array.from({ length: 14 }).map((_, i) => (
          <View key={i} style={styles.scanline} />
        ))}
      </View>
      <View style={styles.barsRow}>
        {Array.from({ length: BAR_COUNT }).map((_, i) => (
          <VisualizerBar key={i} barHeight={barHeights[i]} peakY={peakYs[i]} />
        ))}
      </View>
      {/* Reflection at bottom */}
      <View style={styles.reflection} accessible={false} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: WINAMP.visualizer.bg,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.mid,
    borderRightColor: WINAMP.bevel.mid,
    marginHorizontal: PANEL_MARGIN,
    height: MAX_HEIGHT + 12,
    justifyContent: 'flex-end',
    padding: 3,
    position: 'relative',
    overflow: 'hidden',
  },
  containerOff: {
    backgroundColor: WINAMP.visualizer.bg,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.mid,
    borderRightColor: WINAMP.bevel.mid,
    marginHorizontal: PANEL_MARGIN,
    height: MAX_HEIGHT + 12,
    justifyContent: 'space-between',
    padding: 3,
  },
  scanlineOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    zIndex: 1,
  },
  scanline: {
    height: 1,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  offScanline: {
    height: 1,
    backgroundColor: 'rgba(75, 40, 120, 0.1)',
  },
  barsRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    height: MAX_HEIGHT,
    gap: 1,
  },
  barContainer: {
    flex: 1,
    height: MAX_HEIGHT,
    justifyContent: 'flex-end',
    position: 'relative',
  },
  bar: {
    width: '100%',
    overflow: 'hidden',
    flexDirection: 'column-reverse',
  },
  peak: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: WINAMP.visualizer.peak,
    shadowColor: WINAMP.visualizer.peak,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 3,
  },
  reflection: {
    height: 2,
    backgroundColor: 'rgba(75, 40, 120, 0.15)',
    marginTop: 1,
  },
});
