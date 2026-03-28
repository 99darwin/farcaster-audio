import { useEffect, useRef, useState, useCallback } from 'react';
import { View, StyleSheet, Animated, Dimensions } from 'react-native';
import { Image } from 'expo-image';
import { useAvatarPosition } from '@/contexts/AvatarPositionContext';
import { emojiImageUrl } from '@/constants/emoji';

const SCREEN_WIDTH = Dimensions.get('window').width;
const ANIMATION_DURATION = 2000;
const MAX_VISIBLE = 20;

interface FloatingEmoji {
  id: number;
  key: string;
  x: number;
  y: number;
  opacity: Animated.Value;
  translateY: Animated.Value;
  scale: Animated.Value;
}

interface EmojiReactionOverlayProps {
  reactions: Array<{ key: string; id: number; fid: number }>;
}

export function EmojiReactionOverlay({ reactions }: EmojiReactionOverlayProps) {
  const floatingEmojis = useRef<FloatingEmoji[]>([]);
  const [, setTick] = useState(0);
  const forceUpdate = useCallback(() => setTick((t) => t + 1), []);
  const { measure } = useAvatarPosition();

  useEffect(() => {
    if (reactions.length === 0) return;
    const latest = reactions[reactions.length - 1];

    measure(latest.fid).then((pos) => {
      const opacity = new Animated.Value(1);
      const translateY = new Animated.Value(0);
      const scale = new Animated.Value(0.5);

      const entry: FloatingEmoji = {
        id: latest.id,
        key: latest.key,
        // Center on avatar if found, otherwise random fallback
        x: pos ? pos.x - 18 : 40 + Math.random() * (SCREEN_WIDTH - 100),
        y: pos ? pos.y - 18 : SCREEN_WIDTH,
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
          toValue: -120,
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
    });
  }, [reactions]);

  return (
    <View style={styles.overlay} pointerEvents="none">
      {floatingEmojis.current.map((item) => (
        <Animated.View
          key={item.id}
          style={[
            styles.floatingEmoji,
            {
              left: item.x,
              top: item.y,
              opacity: item.opacity,
              transform: [
                { translateY: item.translateY },
                { scale: item.scale },
              ],
            },
          ]}
        >
          <Image
            source={{ uri: emojiImageUrl(item.key) }}
            style={styles.emojiImage}
            contentFit="contain"
            cachePolicy="memory-disk"
          />
        </Animated.View>
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
  },
  emojiImage: {
    width: 36,
    height: 36,
  },
});
