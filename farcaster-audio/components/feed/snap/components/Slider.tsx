import { useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, type LayoutChangeEvent, type GestureResponderEvent } from 'react-native';
import type { SliderProps } from '@/types/snap';
import { useSnapContext } from '../context';
import { resolvePaletteColor } from '@/constants/snapPalette';
import { colors } from '@/constants/theme';

/**
 * Minimal slider — no external deps. Tap/drag on the track sets the value.
 */
export function SnapSlider({ props }: { props: SliderProps }) {
  const { accent, setInput } = useSnapContext();
  const color = resolvePaletteColor('accent', accent);

  const clampedDefault = Math.max(
    props.min,
    Math.min(props.max, props.defaultValue ?? props.min),
  );
  const [value, setValue] = useState(clampedDefault);
  const [width, setWidth] = useState(0);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    setWidth(e.nativeEvent.layout.width);
  }, []);

  const updateFromX = useCallback(
    (x: number) => {
      if (width <= 0) return;
      const range = props.max - props.min;
      if (range <= 0) return;
      const ratio = Math.max(0, Math.min(1, x / width));
      const step = props.step ?? 1;
      const raw = props.min + ratio * range;
      const stepped = Math.round(raw / step) * step;
      const next = Math.max(props.min, Math.min(props.max, stepped));
      setValue(next);
      setInput(props.name, next);
    },
    [width, props.max, props.min, props.step, props.name, setInput],
  );

  const handlePress = (e: GestureResponderEvent) => {
    updateFromX(e.nativeEvent.locationX);
  };

  const range = props.max - props.min;
  const pct = range > 0 ? (value - props.min) / range : 0;

  return (
    <View style={styles.wrapper}>
      {props.label ? (
        <View style={styles.labelRow}>
          <Text style={styles.label}>{props.label}</Text>
          <Text style={styles.value}>{value}</Text>
        </View>
      ) : null}
      <Pressable
        onLayout={onLayout}
        onPress={handlePress}
        onResponderMove={(e) => updateFromX(e.nativeEvent.locationX)}
        style={styles.track}
      >
        <View style={[styles.fill, { width: `${pct * 100}%`, backgroundColor: color }]} />
        <View
          style={[
            styles.thumb,
            { left: `${pct * 100}%`, backgroundColor: color, borderColor: color },
          ]}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 6 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between' },
  label: { color: colors.text.secondary, fontSize: 12 },
  value: { color: colors.text.body, fontSize: 12, fontVariant: ['tabular-nums'] },
  track: {
    height: 24,
    justifyContent: 'center',
  },
  fill: {
    position: 'absolute',
    left: 0,
    height: 4,
    borderRadius: 999,
  },
  thumb: {
    position: 'absolute',
    width: 16,
    height: 16,
    borderRadius: 8,
    marginLeft: -8,
    borderWidth: 2,
  },
});
