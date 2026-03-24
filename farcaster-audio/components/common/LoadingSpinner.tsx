import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { colors } from '@/constants/theme';

interface LoadingSpinnerProps {
  size?: 'small' | 'large';
  color?: string;
  fullScreen?: boolean;
}

export function LoadingSpinner({
  size = 'large',
  color = colors.accent,
  fullScreen = false,
}: LoadingSpinnerProps) {
  if (fullScreen) {
    return (
      <View style={styles.fullScreen} accessibilityLabel="Loading" accessibilityRole="progressbar">
        <ActivityIndicator size={size} color={color} />
      </View>
    );
  }

  return (
    <View accessibilityLabel="Loading" accessibilityRole="progressbar">
      <ActivityIndicator size={size} color={color} />
    </View>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background.main,
  },
});
