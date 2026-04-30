import { useMemo } from "react";
import { StyleSheet } from "react-native";
import type { ThemeColors, ThemeGlass } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";

export interface ThemedStyleArgs {
  colors: ThemeColors;
  glass: ThemeGlass;
}

export function useThemedStyles<T extends StyleSheet.NamedStyles<T>>(
  fn: (t: ThemedStyleArgs) => T,
): T {
  const { colors, glass } = useTheme();
  return useMemo(
    () => StyleSheet.create(fn({ colors, glass })),
    // The fn is expected to be stable per render; we key on theme tokens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [colors, glass],
  );
}
