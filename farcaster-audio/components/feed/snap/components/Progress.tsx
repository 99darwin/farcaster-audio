import { View, Text } from "react-native";
import type { ProgressProps } from "@/types/snap";
import { useSnapContext } from "../context";
import { resolvePaletteColor } from "@/constants/snapPalette";
import { useThemedStyles } from "@/hooks/useThemedStyles";

export function SnapProgress({ props }: { props: ProgressProps }) {
  const { accent } = useSnapContext();
  const styles = useStyles();
  const color = resolvePaletteColor("accent", accent);
  const max = props.max > 0 ? props.max : 1;
  const pct = Math.max(0, Math.min(1, props.value / max));

  return (
    <View style={styles.wrapper}>
      {props.label ? <Text style={styles.label}>{props.label}</Text> : null}
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { width: `${pct * 100}%`, backgroundColor: color },
          ]}
        />
      </View>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    wrapper: { gap: 4 },
    label: { color: colors.text.secondary, fontSize: 12 },
    track: {
      height: 6,
      borderRadius: 999,
      backgroundColor: colors.background.border,
      overflow: "hidden" as const,
    },
    fill: {
      height: "100%" as const,
      borderRadius: 999,
    },
  }));
