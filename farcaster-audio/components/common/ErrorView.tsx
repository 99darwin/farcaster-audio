import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button } from '@/components/common/Button';
import { colors } from '@/constants/theme';

interface ErrorViewProps {
  message: string;
  onRetry?: () => void;
  fullScreen?: boolean;
}

export function ErrorView({ message, onRetry, fullScreen = false }: ErrorViewProps) {
  return (
    <View style={[styles.container, fullScreen && styles.fullScreen]} accessibilityRole="alert">
      <Ionicons name="alert-circle" size={48} color={colors.error} />
      <Text style={styles.message}>{message}</Text>
      {onRetry && (
        <Button title="Try Again" onPress={onRetry} variant="secondary" size="sm" />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 12,
  },
  fullScreen: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  message: {
    color: colors.text.secondary,
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
});
