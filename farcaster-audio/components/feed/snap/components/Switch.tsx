import { useState } from 'react';
import { View, Text, Switch as RNSwitch, StyleSheet } from 'react-native';
import type { SwitchProps } from '@/types/snap';
import { useSnapContext } from '../context';
import { resolvePaletteColor } from '@/constants/snapPalette';
import { colors } from '@/constants/theme';

export function SnapSwitch({ props }: { props: SwitchProps }) {
  const { accent, setInput } = useSnapContext();
  const color = resolvePaletteColor('accent', accent);
  const [checked, setChecked] = useState(props.defaultChecked ?? false);

  const handleChange = (next: boolean) => {
    setChecked(next);
    setInput(props.name, next);
  };

  return (
    <View style={styles.row}>
      {props.label ? <Text style={styles.label}>{props.label}</Text> : null}
      <RNSwitch
        value={checked}
        onValueChange={handleChange}
        trackColor={{ false: colors.background.border, true: color }}
        thumbColor="#ffffff"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  label: {
    color: colors.text.body,
    fontSize: 13,
    flex: 1,
  },
});
