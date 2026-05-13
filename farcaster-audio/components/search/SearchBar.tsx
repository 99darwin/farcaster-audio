import { useRef } from "react";
import {
  Pressable,
  TextInput,
  View,
  Text,
  StyleSheet,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { GlassView } from "@/components/common/GlassView";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { radii, spacing, typography } from "@/constants/theme";

interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  onCancel: () => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function SearchBar({
  value,
  onChangeText,
  onCancel,
  placeholder = "Search Farcaster",
  autoFocus = true,
}: SearchBarProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const inputRef = useRef<TextInput>(null);

  return (
    <View style={styles.container}>
      <GlassView style={styles.field}>
        <View style={styles.fieldInner}>
          <Ionicons
            name="search"
            size={18}
            color={colors.text.secondary}
            style={styles.icon}
          />
          <TextInput
            ref={inputRef}
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            placeholderTextColor={colors.text.placeholder}
            style={styles.input}
            autoFocus={autoFocus}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search"
            clearButtonMode="while-editing"
          />
        </View>
      </GlassView>
      <Pressable
        onPress={onCancel}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Cancel search"
        style={styles.cancelButton}
      >
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
      backgroundColor: colors.background.surface,
    },
    field: {
      flex: 1,
      borderRadius: radii.full,
      overflow: "hidden" as const,
    },
    fieldInner: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      paddingHorizontal: spacing.md,
      paddingVertical: Platform.OS === "ios" ? spacing.sm : spacing.xs,
      gap: spacing.sm,
    },
    icon: {
      opacity: 0.9,
    },
    input: {
      flex: 1,
      color: colors.text.primary,
      fontSize: typography.size.body,
      paddingVertical: 0,
    },
    cancelButton: {
      paddingHorizontal: spacing.xs,
      paddingVertical: spacing.xs,
    },
    cancelText: {
      color: colors.accent,
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
    },
  }));
