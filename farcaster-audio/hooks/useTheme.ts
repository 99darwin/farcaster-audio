import { useMemo } from "react";
import { useColorScheme } from "react-native";
import {
  type ColorScheme,
  type ThemeColors,
  type ThemeGlass,
  getColors,
  getGlass,
} from "@/constants/theme";
import { usePrefsStore } from "@/stores/prefsStore";

export interface Theme {
  scheme: ColorScheme;
  colors: ThemeColors;
  glass: ThemeGlass;
}

export function useTheme(): Theme {
  const pref = usePrefsStore((s) => s.appearancePref);
  const system = useColorScheme();
  const resolvedSystem: ColorScheme = system === "light" ? "light" : "dark";
  const scheme: ColorScheme = pref === "system" ? resolvedSystem : pref;

  return useMemo(
    () => ({
      scheme,
      colors: getColors(scheme),
      glass: getGlass(scheme),
    }),
    [scheme],
  );
}
