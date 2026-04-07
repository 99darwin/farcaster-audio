import { View, StyleSheet } from 'react-native';
import type { SeparatorProps } from '@/types/snap';
import { colors } from '@/constants/theme';

export function SnapSeparator({ props }: { props: SeparatorProps }) {
  const vertical = props.orientation === 'vertical';
  return (
    <View
      style={[
        styles.base,
        vertical
          ? { width: StyleSheet.hairlineWidth, alignSelf: 'stretch' }
          : { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  base: {
    backgroundColor: colors.background.border,
  },
});
