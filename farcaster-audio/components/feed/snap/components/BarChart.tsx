import { View, Text } from "react-native";
import type { BarChartProps } from "@/types/snap";
import { useSnapContext } from "../context";
import { resolvePaletteColor } from "@/constants/snapPalette";
import { useThemedStyles } from "@/hooks/useThemedStyles";

export function SnapBarChart({ props }: { props: BarChartProps }) {
  const { accent } = useSnapContext();
  const styles = useStyles();
  const bars = (props.bars ?? []).slice(0, 6);
  const maxValue = props.max ?? bars.reduce((m, b) => Math.max(m, b.value), 0);
  const safeMax = maxValue > 0 ? maxValue : 1;
  const baseColor = resolvePaletteColor(props.color, accent);

  return (
    <View style={styles.chart}>
      {bars.map((bar, i) => {
        const pct = Math.max(0, Math.min(1, bar.value / safeMax));
        const color = bar.color
          ? resolvePaletteColor(bar.color, accent)
          : baseColor;
        return (
          <View key={`${i}-${bar.label}`} style={styles.row}>
            <Text style={styles.label} numberOfLines={1}>
              {bar.label}
            </Text>
            <View style={styles.track}>
              <View
                style={[
                  styles.fill,
                  { width: `${pct * 100}%`, backgroundColor: color },
                ]}
              />
            </View>
            <Text style={styles.value}>{bar.value}</Text>
          </View>
        );
      })}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    chart: { gap: 6 },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 8,
    },
    label: {
      width: 72,
      color: colors.text.secondary,
      fontSize: 12,
    },
    track: {
      flex: 1,
      height: 8,
      borderRadius: 999,
      backgroundColor: colors.background.border,
      overflow: "hidden" as const,
    },
    fill: {
      height: "100%" as const,
      borderRadius: 999,
    },
    value: {
      width: 36,
      textAlign: "right" as const,
      color: colors.text.body,
      fontSize: 12,
      fontVariant: ["tabular-nums" as const],
    },
  }));
