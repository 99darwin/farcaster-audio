import { Pressable, Text, View, StyleSheet, ActivityIndicator } from 'react-native';
import type { ButtonProps, SnapEvents } from '@/types/snap';
import { useSnapContext } from '../context';
import { resolvePaletteColor } from '@/constants/snapPalette';
import { colors } from '@/constants/theme';

interface Props {
  id: string;
  props: ButtonProps;
  on?: SnapEvents;
}

export function SnapButton({ id, props, on }: Props) {
  const { accent, submitButton, signerStatus, submitting } = useSnapContext();
  const accentColor = resolvePaletteColor('accent', accent);
  const primary = props.variant !== 'secondary';

  // Treat any button as interactive unless it's an explicit link-out.
  // Snaps in the wild don't always set `on.press.type` — default to submit.
  const pressAction = on?.press as { type?: string } | undefined;
  const isLink = pressAction?.type === 'link' || pressAction?.type === 'open_url';
  const canInteract = !isLink && !submitting;

  const handlePress = () => {
    if (!canInteract) return;
    submitButton(id).catch(() => {});
  };

  const showEnableHint = !isLink && signerStatus !== 'approved';

  return (
    <Pressable
      disabled={!canInteract}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: accentColor }
          : { borderWidth: 1, borderColor: accentColor, backgroundColor: 'transparent' },
        pressed && canInteract ? { opacity: 0.8 } : null,
        isLink ? styles.disabled : null,
      ]}
    >
      <View style={styles.row}>
        {submitting ? (
          <ActivityIndicator size="small" color={primary ? '#ffffff' : accentColor} />
        ) : null}
        <Text
          style={[
            styles.label,
            { color: primary ? '#ffffff' : accentColor },
          ]}
          numberOfLines={1}
        >
          {props.label}
        </Text>
      </View>
      {showEnableHint ? (
        <Text style={styles.hint}>
          {signerStatus === 'pending_approval' ? 'Awaiting approval' : 'Tap to enable'}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
  hint: {
    marginTop: 2,
    fontSize: 10,
    color: colors.text.secondary,
  },
});
