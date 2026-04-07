import { View, Text, StyleSheet } from 'react-native';
import type { BadgeProps } from '@/types/snap';
import { useSnapContext } from '../context';
import { resolvePaletteColor } from '@/constants/snapPalette';

export function SnapBadge({ props }: { props: BadgeProps }) {
  const { accent } = useSnapContext();
  const color = resolvePaletteColor(props.color, accent);
  const outline = props.variant === 'outline';

  return (
    <View
      style={[
        styles.badge,
        outline
          ? { borderColor: color, borderWidth: 1, backgroundColor: 'transparent' }
          : { backgroundColor: color + '22', borderWidth: 1, borderColor: color + '55' },
      ]}
    >
      <Text style={[styles.label, { color }]} numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    alignSelf: 'flex-start',
  },
  label: {
    fontSize: 11,
    fontWeight: '600',
  },
});
