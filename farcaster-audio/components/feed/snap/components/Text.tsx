import { Text as RNText, StyleSheet } from "react-native";
import type { TextProps } from "@/types/snap";
import { colors, typography } from "@/constants/theme";

export function SnapText({ props }: { props: TextProps }) {
  const fontSize =
    props.size === "sm" ? typography.size.sm : typography.size.body;
  const fontWeight =
    props.weight === "bold"
      ? typography.weight.bold
      : typography.weight.regular;
  const textAlign = props.align ?? "left";
  return (
    <RNText style={[styles.text, { fontSize, fontWeight, textAlign }]}>
      {props.content}
    </RNText>
  );
}

const styles = StyleSheet.create({
  text: {
    color: colors.text.body,
  },
});
