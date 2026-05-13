import { Pressable, StyleSheet, Text, View } from "react-native";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { typography } from "@/constants/theme";

export interface TabStripItem<K extends string = string> {
  key: K;
  label: string;
}

interface TabStripProps<K extends string> {
  tabs: TabStripItem<K>[];
  activeKey: K;
  onChange: (key: K) => void;
}

export function TabStrip<K extends string>({
  tabs,
  activeKey,
  onChange,
}: TabStripProps<K>) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      {tabs.map((tab) => {
        const isActive = tab.key === activeKey;
        return (
          <Pressable
            key={tab.key}
            onPress={() => onChange(tab.key)}
            style={[styles.tab, isActive && styles.tabActive]}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={tab.label}
          >
            <Text
              style={[styles.tabText, isActive && styles.tabTextActive]}
              numberOfLines={1}
              allowFontScaling={false}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    row: {
      flexDirection: "row" as const,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.background.border,
      backgroundColor: colors.background.surface,
    },
    tab: {
      flex: 1,
      paddingVertical: 12,
      paddingHorizontal: 4,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      borderBottomWidth: 2,
      borderBottomColor: "transparent",
    },
    tabActive: {
      borderBottomColor: colors.purple,
    },
    tabText: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      fontWeight: typography.weight.semibold,
      textAlign: "center" as const,
    },
    tabTextActive: {
      color: colors.text.primary,
    },
  }));
