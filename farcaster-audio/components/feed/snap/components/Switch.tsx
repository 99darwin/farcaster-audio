import { useState } from "react";
import { View, Text, Switch as RNSwitch } from "react-native";
import type { SwitchProps } from "@/types/snap";
import { useSnapContext } from "../context";
import { resolvePaletteColor } from "@/constants/snapPalette";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

export function SnapSwitch({ props }: { props: SwitchProps }) {
  const { accent, setInput } = useSnapContext();
  const { colors } = useTheme();
  const styles = useStyles();
  const color = resolvePaletteColor("accent", accent);
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

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      gap: 8,
    },
    label: {
      color: colors.text.body,
      fontSize: 13,
      flex: 1,
    },
  }));
