import { Pressable } from "react-native";
import { type Href, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/hooks/useTheme";

interface HeaderSearchButtonProps {
  href: Href;
  label: string;
}

/** Top-left header search for the tab screens. */
export function HeaderSearchButton({ href, label }: HeaderSearchButtonProps) {
  const { colors } = useTheme();
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push(href)}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID="header-search-button"
    >
      <Ionicons name="search" size={22} color={colors.text.primary} />
    </Pressable>
  );
}
