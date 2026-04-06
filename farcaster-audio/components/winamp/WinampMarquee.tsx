import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Animated, StyleSheet, type LayoutChangeEvent } from 'react-native';
import { WINAMP, PANEL_MARGIN } from './winampTheme';

const SCROLL_SPEED = 40; // pixels per second

interface WinampMarqueeProps {
  title: string;
  hostName: string;
  listenerCount: number;
}

export function WinampMarquee({ title, hostName, listenerCount }: WinampMarqueeProps) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const [containerWidth, setContainerWidth] = useState(0);
  const [textWidth, setTextWidth] = useState(0);
  const textContent = `  \u2605 ${title} \u2605\u2605\u2605 hosted by ${hostName} \u2605\u2605\u2605 ${listenerCount} listening \u2605\u2605\u2605  `;

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    setContainerWidth(e.nativeEvent.layout.width);
  }, []);

  const onTextLayout = useCallback((e: LayoutChangeEvent) => {
    setTextWidth(e.nativeEvent.layout.width);
  }, []);

  useEffect(() => {
    if (containerWidth === 0 || textWidth === 0) return;

    const totalDistance = containerWidth + textWidth;
    const duration = (totalDistance / SCROLL_SPEED) * 1000;

    scrollX.setValue(containerWidth);
    const animation = Animated.loop(
      Animated.timing(scrollX, {
        toValue: -textWidth,
        duration,
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [title, hostName, listenerCount, scrollX, containerWidth, textWidth]);

  return (
    <View
      style={styles.outer}
      accessibilityRole="text"
      accessibilityLabel={`${title}, hosted by ${hostName}, ${listenerCount} listening`}
    >
      <View style={styles.container}>
        {/* Scanline overlay effect */}
        <View style={styles.scanlines} accessible={false}>
          {Array.from({ length: 8 }).map((_, i) => (
            <View key={i} style={styles.scanline} />
          ))}
        </View>
        <View style={styles.overflow} onLayout={onContainerLayout}>
          <Animated.Text
            style={[styles.text, { transform: [{ translateX: scrollX }] }]}
            numberOfLines={1}
            onLayout={onTextLayout}
          >
            {textContent}
          </Animated.Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    marginHorizontal: PANEL_MARGIN,
    marginTop: 2,
  },
  container: {
    backgroundColor: WINAMP.lcd.bg,
    borderWidth: 2,
    borderTopColor: WINAMP.bevel.dark,
    borderLeftColor: WINAMP.bevel.dark,
    borderBottomColor: WINAMP.bevel.mid,
    borderRightColor: WINAMP.bevel.mid,
    paddingVertical: 5,
    paddingHorizontal: 4,
    overflow: 'hidden',
    position: 'relative',
  },
  scanlines: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'space-between',
    opacity: 0.15,
  },
  scanline: {
    height: 1,
    backgroundColor: '#000000',
  },
  overflow: {
    overflow: 'hidden',
  },
  text: {
    fontFamily: WINAMP.fonts.pixel,
    fontSize: 9,
    color: WINAMP.lcd.textBright,
    letterSpacing: 1,
    textShadowColor: WINAMP.lcd.glow,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 8,
  },
});
