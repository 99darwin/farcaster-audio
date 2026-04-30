import { useState } from "react";
import { View, Text, TextInput } from "react-native";
import type { InputProps } from "@/types/snap";
import { useSnapContext } from "../context";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

export function SnapInput({ props }: { props: InputProps }) {
  const { setInput } = useSnapContext();
  const { colors } = useTheme();
  const styles = useStyles();
  const [value, setValue] = useState(props.defaultValue ?? "");

  const handleChange = (next: string) => {
    setValue(next);
    if (props.type === "number") {
      const n = Number(next);
      setInput(props.name, Number.isFinite(n) ? n : next);
    } else {
      setInput(props.name, next);
    }
  };

  return (
    <View style={styles.wrapper}>
      {props.label ? <Text style={styles.label}>{props.label}</Text> : null}
      <TextInput
        value={value}
        onChangeText={handleChange}
        placeholder={props.placeholder}
        placeholderTextColor={colors.text.placeholder}
        maxLength={props.maxLength ?? 280}
        keyboardType={props.type === "number" ? "numeric" : "default"}
        style={styles.input}
      />
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    wrapper: { gap: 4 },
    label: { color: colors.text.secondary, fontSize: 12 },
    input: {
      borderWidth: 1,
      borderColor: colors.background.border,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 8,
      color: colors.text.primary,
      fontSize: 14,
      backgroundColor: colors.background.surface,
    },
  }));
