import { useCallback, useEffect, useState } from 'react';
import { View, Text, Switch, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, typography } from '@/constants/theme';
import * as api from '@/services/api';

interface Preferences {
  follows_enabled: boolean;
  likes_enabled: boolean;
  replies_enabled: boolean;
  recasts_enabled: boolean;
  space_started_enabled: boolean;
  space_invited_enabled: boolean;
  hand_raised_enabled: boolean;
  miniapp_enabled: boolean;
}

const DEFAULT_PREFS: Preferences = {
  follows_enabled: true,
  likes_enabled: true,
  replies_enabled: true,
  recasts_enabled: true,
  space_started_enabled: true,
  space_invited_enabled: true,
  hand_raised_enabled: true,
  miniapp_enabled: false,
};

type ToggleRow = {
  key: keyof Preferences;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  disabled?: boolean;
  sublabel?: string;
};

const FARCASTER_TOGGLES: ToggleRow[] = [
  { key: 'follows_enabled', label: 'Follows', icon: 'person-add-outline' },
  { key: 'likes_enabled', label: 'Likes', icon: 'heart-outline' },
  { key: 'replies_enabled', label: 'Comments', icon: 'chatbubble-outline' },
  { key: 'recasts_enabled', label: 'Recasts', icon: 'repeat-outline' },
];

const SPACE_TOGGLES: ToggleRow[] = [
  { key: 'space_invited_enabled', label: 'Invited to Speak', icon: 'mic-outline' },
  { key: 'hand_raised_enabled', label: 'Hand Raised', icon: 'hand-left-outline' },
];

const COMING_SOON_TOGGLES: ToggleRow[] = [
  { key: 'miniapp_enabled', label: 'Mini App Notifications', icon: 'apps-outline', disabled: true, sublabel: 'Coming soon' },
];

export default function NotificationSettingsScreen() {
  const [prefs, setPrefs] = useState<Preferences>(DEFAULT_PREFS);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadPreferences();
  }, []);

  async function loadPreferences() {
    try {
      const data = await api.getNotificationPreferences();
      setPrefs(data);
    } catch (error) {
      if (__DEV__) console.error('[NotifSettings] Failed to load preferences:', error);
    } finally {
      setIsLoading(false);
    }
  }

  const handleToggle = useCallback(async (key: keyof Preferences, value: boolean) => {
    // Optimistic update
    setPrefs((prev) => ({ ...prev, [key]: value }));
    try {
      await api.updateNotificationPreferences({ [key]: value });
    } catch (error) {
      // Revert on failure
      setPrefs((prev) => ({ ...prev, [key]: !value }));
      if (__DEV__) console.error('[NotifSettings] Failed to update preference:', error);
    }
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={colors.purple} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <Section title="Farcaster" toggles={FARCASTER_TOGGLES} prefs={prefs} onToggle={handleToggle} />
      <Section title="Spaces" toggles={SPACE_TOGGLES} prefs={prefs} onToggle={handleToggle} />
      <Section title="Other" toggles={COMING_SOON_TOGGLES} prefs={prefs} onToggle={handleToggle} />
    </ScrollView>
  );
}

function Section({
  title,
  toggles,
  prefs,
  onToggle,
}: {
  title: string;
  toggles: ToggleRow[];
  prefs: Preferences;
  onToggle: (key: keyof Preferences, value: boolean) => void;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>
        {toggles.map((toggle, index) => (
          <View
            key={toggle.key}
            style={[
              styles.row,
              index < toggles.length - 1 && styles.rowBorder,
            ]}
          >
            <Ionicons
              name={toggle.icon}
              size={20}
              color={toggle.disabled ? colors.text.placeholder : colors.purple}
            />
            <View style={styles.rowTextContainer}>
              <Text style={[styles.rowText, toggle.disabled && styles.rowTextDisabled]}>
                {toggle.label}
              </Text>
              {toggle.sublabel && (
                <Text style={styles.rowSublabel}>{toggle.sublabel}</Text>
              )}
            </View>
            <Switch
              value={prefs[toggle.key]}
              onValueChange={(value) => onToggle(toggle.key, value)}
              disabled={toggle.disabled}
              trackColor={{ false: colors.background.subtle, true: colors.purple }}
              thumbColor="#ffffff"
            />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  section: {
    marginTop: spacing.xl,
  },
  sectionTitle: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
    fontWeight: typography.weight.semibold,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: spacing['2xl'],
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing['2xl'],
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
  rowTextDisabled: {
    color: colors.text.placeholder,
  },
  rowSublabel: {
    color: colors.text.placeholder,
    fontSize: typography.size.sm,
    marginTop: 2,
  },
});
