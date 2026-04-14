import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  Easing,
} from "react-native-reanimated";

const PARTICLE_COUNT = 30;
const DURATION_MS = 1200;
const COLORS = [
  "#855DCD",
  "#3b82f6",
  "#10b981",
  "#f59e0b",
  "#ec4899",
  "#14b8a6",
];

interface ParticleSpec {
  color: string;
  startX: number;
  endX: number;
  endY: number;
  rotation: number;
  delay: number;
  size: number;
}

function makeParticles(): ParticleSpec[] {
  const particles: ParticleSpec[] = [];
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    particles.push({
      color: COLORS[i % COLORS.length],
      startX: 40 + Math.random() * 20, // starts near center horizontally (%)
      endX: Math.random() * 100,
      endY: 60 + Math.random() * 40, // falls downward (%)
      rotation: (Math.random() - 0.5) * 720,
      delay: Math.random() * 150,
      size: 5 + Math.random() * 4,
    });
  }
  return particles;
}

function Particle({ spec }: { spec: ParticleSpec }) {
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withDelay(
      spec.delay,
      withTiming(1, { duration: DURATION_MS, easing: Easing.out(Easing.quad) }),
    );
  }, [progress, spec.delay]);

  const style = useAnimatedStyle(() => {
    const p = progress.value;
    const x = spec.startX + (spec.endX - spec.startX) * p;
    const y = spec.endY * p;
    const opacity = 1 - p;
    return {
      left: `${x}%`,
      top: `${y}%`,
      opacity,
      transform: [{ rotate: `${spec.rotation * p}deg` }],
    };
  });

  return (
    <Animated.View
      style={[
        styles.particle,
        { backgroundColor: spec.color, width: spec.size, height: spec.size },
        style,
      ]}
    />
  );
}

/**
 * One-shot confetti burst. Keyed so remounting re-fires the animation.
 */
export function Confetti({ triggerKey }: { triggerKey: string | number }) {
  const particles = useMemo(makeParticles, [triggerKey]);

  return (
    <View pointerEvents="none" style={styles.overlay}>
      {particles.map((spec, i) => (
        <Particle key={`${triggerKey}-${i}`} spec={spec} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    overflow: "hidden",
  },
  particle: {
    position: "absolute",
    borderRadius: 2,
  },
});
