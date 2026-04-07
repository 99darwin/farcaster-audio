import { Text, StyleSheet } from 'react-native';
import type { IconProps } from '@/types/snap';
import { useSnapContext } from '../context';
import { resolvePaletteColor } from '@/constants/snapPalette';

/**
 * Placeholder icon renderer. The snap spec defines a named IconName set, but
 * we don't bundle a matching glyph library yet. Render a colored dot with the
 * first initial of the icon name as a minimal affordance.
 */
export function SnapIcon({ props }: { props: IconProps }) {
  const { accent } = useSnapContext();
  const color = resolvePaletteColor(props.color, accent);
  const dim = props.size === 'sm' ? 14 : 18;
  const initial = (props.name ?? '?').charAt(0).toUpperCase();

  return (
    <Text
      style={[
        styles.icon,
        {
          color,
          fontSize: dim,
          lineHeight: dim + 2,
          width: dim + 4,
          height: dim + 4,
        },
      ]}
    >
      {initial}
    </Text>
  );
}

const styles = StyleSheet.create({
  icon: {
    textAlign: 'center',
    fontWeight: '700',
  },
});
