import { Pressable, Text, ActivityIndicator, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import * as Haptics from 'expo-haptics';
import { colors, touchTarget } from '@/constants/theme';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

interface ButtonProps {
  title: string;
  onPress: () => void;
  variant?: ButtonVariant;
  isLoading?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg' | 'small' | 'medium' | 'large';
  accessibilityLabel?: string;
}

const NORMALIZE_SIZE: Record<string, 'sm' | 'md' | 'lg'> = {
  sm: 'sm',
  md: 'md',
  lg: 'lg',
  small: 'sm',
  medium: 'md',
  large: 'lg',
};

const VARIANT_STYLES: Record<ButtonVariant, { bg: string; text: string; border: string }> = {
  primary: { bg: colors.accent, text: colors.text.primary, border: 'transparent' },
  secondary: { bg: 'transparent', text: colors.accent, border: colors.accent },
  danger: { bg: colors.danger, text: colors.text.primary, border: 'transparent' },
  ghost: { bg: 'transparent', text: colors.text.secondary, border: 'transparent' },
};

const SIZE_STYLES: Record<string, { paddingVertical: number; paddingHorizontal: number; fontSize: number }> = {
  sm: { paddingVertical: 6, paddingHorizontal: 12, fontSize: 13 },
  md: { paddingVertical: 10, paddingHorizontal: 20, fontSize: 15 },
  lg: { paddingVertical: 14, paddingHorizontal: 28, fontSize: 17 },
};

export function Button({
  title,
  onPress,
  variant = 'primary',
  isLoading = false,
  disabled = false,
  size = 'md',
  accessibilityLabel,
}: ButtonProps) {
  const variantStyle = VARIANT_STYLES[variant];
  const normalizedSize = NORMALIZE_SIZE[size] ?? 'md';
  const sizeStyle = SIZE_STYLES[normalizedSize];
  const isDisabled = disabled || isLoading;

  const handlePress = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={isDisabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: isDisabled, busy: isLoading }}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: variantStyle.bg,
          borderColor: variantStyle.border,
          borderWidth: variantStyle.border !== 'transparent' ? 1.5 : 0,
          paddingVertical: sizeStyle.paddingVertical,
          paddingHorizontal: sizeStyle.paddingHorizontal,
          opacity: isDisabled ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      {isLoading ? (
        <ActivityIndicator color={variantStyle.text} size="small" />
      ) : (
        <Text style={[styles.text, { color: variantStyle.text, fontSize: sizeStyle.fontSize }]}>
          {title}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    minHeight: touchTarget.min,
  },
  text: {
    fontWeight: '600',
  },
});
