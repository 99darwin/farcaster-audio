import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import type { ToggleGroupProps } from "@/types/snap";
import { useSnapContext } from "../context";
import { resolvePaletteColor } from "@/constants/snapPalette";
import { colors } from "@/constants/theme";

function initialValue(props: ToggleGroupProps): string[] {
  if (Array.isArray(props.defaultValue)) return props.defaultValue;
  if (typeof props.defaultValue === "string") return [props.defaultValue];
  return [];
}

export function SnapToggleGroup({ props }: { props: ToggleGroupProps }) {
  const { accent, setInput } = useSnapContext();
  const color = resolvePaletteColor("accent", accent);
  const [selected, setSelected] = useState<string[]>(initialValue(props));

  const toggle = (option: string) => {
    let next: string[];
    if (props.multiple) {
      next = selected.includes(option)
        ? selected.filter((v) => v !== option)
        : [...selected, option];
    } else {
      next = [option];
    }
    setSelected(next);
    setInput(props.name, props.multiple ? next : (next[0] ?? ""));
  };

  const vertical = props.orientation === "vertical";
  const outline = props.variant === "outline";

  return (
    <View style={styles.wrapper}>
      {props.label ? <Text style={styles.label}>{props.label}</Text> : null}
      <View
        style={[styles.group, { flexDirection: vertical ? "column" : "row" }]}
      >
        {props.options.map((option) => {
          const isSelected = selected.includes(option);
          return (
            <Pressable
              key={option}
              onPress={() => toggle(option)}
              style={[
                styles.option,
                outline
                  ? {
                      borderWidth: 1,
                      borderColor: isSelected
                        ? color
                        : colors.background.border,
                    }
                  : null,
                isSelected
                  ? { backgroundColor: outline ? color + "22" : color }
                  : {
                      backgroundColor: outline
                        ? "transparent"
                        : colors.background.surface,
                    },
              ]}
            >
              <Text
                style={[
                  styles.optionLabel,
                  {
                    color:
                      isSelected && !outline ? "#ffffff" : colors.text.body,
                  },
                ]}
                numberOfLines={1}
              >
                {option}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: 6 },
  label: { color: colors.text.secondary, fontSize: 12 },
  group: {
    gap: 6,
    flexWrap: "wrap",
  },
  option: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  optionLabel: {
    fontSize: 13,
    fontWeight: "600",
  },
});
