import { Text as RNText } from "react-native";
import type { TextProps } from "@/types/snap";
import { typography } from "@/constants/theme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

export function SnapText({ props }: { props: TextProps }) {
  const styles = useStyles();
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

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    text: {
      color: colors.text.body,
    },
  }));
