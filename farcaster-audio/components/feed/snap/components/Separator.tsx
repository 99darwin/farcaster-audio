import { View, StyleSheet } from "react-native";
import type { SeparatorProps } from "@/types/snap";
import { useThemedStyles } from "@/hooks/useThemedStyles";

export function SnapSeparator({ props }: { props: SeparatorProps }) {
  const styles = useStyles();
  const vertical = props.orientation === "vertical";
  return (
    <View
      style={[
        styles.base,
        vertical
          ? { width: StyleSheet.hairlineWidth, alignSelf: "stretch" }
          : { height: StyleSheet.hairlineWidth, alignSelf: "stretch" },
      ]}
    />
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    base: {
      backgroundColor: colors.background.border,
    },
  }));
