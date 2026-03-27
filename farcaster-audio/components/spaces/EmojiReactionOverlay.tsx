import { useEffect, useRef, useState, useCallback } from 'react';
import { View, StyleSheet, Animated, Dimensions } from 'react-native';

const SCREEN_WIDTH = Dimensions.get('window').width;
const ANIMATION_DURATION = 2000;
const MAX_VISIBLE = 20;

interface FloatingEmoji {
  id: number;
  emoji: string;
  x: number;
  opacity: Animated.Value;
  translateY: Animated.Value;
  scale: Animated.Value;
}

interface EmojiReactionOverlayProps {
  reactions: Array<{ emoji: string; id: number }>;
}

export function EmojiReactionOverlay({ reactions }: EmojiReactionOverlayProps) {
  const floatingEmojis = useRef<FloatingEmoji[]>([]);
  const [, setTick] = useState(0);
  const forceUpdate = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (reactions.length === 0) return;
    const latest = reactions[reactions.length - 1];

    const opacity = new Animated.Value(1);
    const translateY = new Animated.Value(0);
    const scale = new Animated.Value(0.5);

    const entry: FloatingEmoji = {
      id: latest.id,
      emoji: latest.emoji,
      x: 40 + Math.random() * (SCREEN_WIDTH - 100),
      opacity,
      translateY,
      scale,
    };

    floatingEmojis.current = [
      ...floatingEmojis.current.slice(-MAX_VISIBLE),
      entry,
    ];
    forceUpdate();

    Animated.parallel([
      Animated.timing(translateY, {
        toValue: -300,
        duration: ANIMATION_DURATION,
        useNativeDriver: true,
      }),
      Animated.sequence([
        Animated.spring(scale, {
          toValue: 1,
          friction: 4,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 0.4,
          duration: ANIMATION_DURATION * 0.4,
          useNativeDriver: true,
        }),
      ]),
      Animated.timing(opacity, {
        toValue: 0,
        duration: ANIMATION_DURATION,
        useNativeDriver: true,
      }),
    ]).start(() => {
      floatingEmojis.current = floatingEmojis.current.filter(
        (e) => e.id !== entry.id,
      );
      forceUpdate();
    });
  }, [reactions]);

  return (
    <View style={styles.overlay} pointerEvents="none">
      {floatingEmojis.current.map((item) => (
        <Animated.Text
          key={item.id}
          style={[
            styles.floatingEmoji,
            {
              left: item.x,
              opacity: item.opacity,
              transform: [
                { translateY: item.translateY },
                { scale: item.scale },
              ],
            },
          ]}
        >
          {item.emoji}
        </Animated.Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100,
  },
  floatingEmoji: {
    position: 'absolute',
    bottom: 160,
    fontSize: 32,
  },
});
