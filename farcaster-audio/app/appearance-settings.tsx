import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { usePrefsStore, type AppearancePref } from "@/stores/prefsStore";
import { spacing, typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface Option {
  value: AppearancePref;
  label: string;
  description: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const OPTIONS: Option[] = [
  {
    value: "system",
    label: "System",
    description: "Follow your device's appearance",
    icon: "phone-portrait-outline",
  },
  {
    value: "light",
    label: "Light",
    description: "Cream background, navy text",
    icon: "sunny-outline",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Deep navy background",
    icon: "moon-outline",
  },
];

const SWATCH_CREAM = "#FFF8F0";
const SWATCH_NAVY = "#0f0f23";
const SWATCH_NAVY_TEXT = "#1A1F36";
const SWATCH_ACCENT = "#D85A30";

function ThemeSwatch({ value }: { value: AppearancePref }) {
  if (value === "system") {
    return (
      <View
        style={swatchStyles.container}
        accessible={false}
        importantForAccessibility="no"
      >
        <View style={swatchStyles.systemLight} />
        <View style={swatchStyles.systemDark} />
        <View style={swatchStyles.systemAccent} />
      </View>
    );
  }
  if (value === "light") {
    return (
      <View
        style={[swatchStyles.container, { backgroundColor: SWATCH_CREAM }]}
        accessible={false}
        importantForAccessibility="no"
      >
        <View
          style={[swatchStyles.dot, { backgroundColor: SWATCH_NAVY_TEXT }]}
        />
      </View>
    );
  }
  return (
    <View
      style={[swatchStyles.container, { backgroundColor: SWATCH_NAVY }]}
      accessible={false}
      importantForAccessibility="no"
    >
      <View style={[swatchStyles.dot, { backgroundColor: SWATCH_CREAM }]} />
    </View>
  );
}

const SWATCH_SIZE = 28;

const swatchStyles = StyleSheet.create({
  container: {
    width: SWATCH_SIZE,
    height: SWATCH_SIZE,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(0,0,0,0.15)",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  systemLight: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: SWATCH_SIZE / 2,
    backgroundColor: SWATCH_CREAM,
  },
  systemDark: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: SWATCH_SIZE / 2,
    backgroundColor: SWATCH_NAVY,
  },
  systemAccent: {
    position: "absolute",
    left: SWATCH_SIZE / 2 - 1,
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: SWATCH_ACCENT,
  },
});

export default function AppearanceSettingsScreen() {
  const { colors } = useTheme();
  const styles = useStyles();
  const appearancePref = usePrefsStore((s) => s.appearancePref);
  const setAppearancePref = usePrefsStore((s) => s.setAppearancePref);

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Theme</Text>
        <View style={styles.sectionBody}>
          {OPTIONS.map((option, index) => {
            const isSelected = appearancePref === option.value;
            return (
              <Pressable
                key={option.value}
                style={[
                  styles.row,
                  index < OPTIONS.length - 1 && styles.rowBorder,
                ]}
                onPress={() => setAppearancePref(option.value)}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${option.label}: ${option.description}`}
              >
                <ThemeSwatch value={option.value} />
                <Ionicons name={option.icon} size={20} color={colors.purple} />
                <View style={styles.rowTextContainer}>
                  <Text style={styles.rowText}>{option.label}</Text>
                  <Text style={styles.rowSublabel}>{option.description}</Text>
                </View>
                {isSelected && (
                  <Ionicons name="checkmark" size={22} color={colors.accent} />
                )}
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.footnote}>
          Light mode uses warm cream tones to keep Juke feeling welcoming. Brand
          accents stay constant in both modes.
        </Text>
      </View>
    </ScrollView>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
    },
    section: {
      marginTop: spacing.xl,
    },
    sectionTitle: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      fontWeight: typography.weight.semibold,
      textTransform: "uppercase" as const,
      letterSpacing: 0.5,
      paddingHorizontal: spacing["2xl"],
      marginBottom: spacing.sm,
    },
    sectionBody: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.background.border,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
      backgroundColor: colors.background.surface,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingHorizontal: spacing["2xl"],
      paddingVertical: 14,
    },
    rowBorder: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
    },
    rowTextContainer: {
      flex: 1,
    },
    rowText: {
      color: colors.text.primary,
      fontSize: 16,
    },
    rowSublabel: {
      color: colors.text.secondary,
      fontSize: typography.size.body2,
      marginTop: 2,
    },
    footnote: {
      color: colors.text.secondary,
      fontSize: typography.size.body2,
      paddingHorizontal: spacing["2xl"],
      marginTop: spacing.lg,
      lineHeight: 18,
    },
  }));
