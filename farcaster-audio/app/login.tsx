import { useState } from 'react';
import { View, Text, Image, StyleSheet, Pressable, Alert } from 'react-native';
import { Redirect } from 'expo-router';
import { SignInButton } from '@/components/auth/SignInButton';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import { colors } from '@/constants/theme';
import * as api from '@/services/api';

export default function LoginScreen() {
  const { isAuthenticated, isLoading } = useAuth();
  const [devLoading, setDevLoading] = useState(false);

  if (isLoading) {
    return <LoadingSpinner fullScreen />;
  }

  if (isAuthenticated) {
    return <Redirect href="/" />;
  }

  const devLogin = async () => {
    setDevLoading(true);
    try {
      const response = await api.devLogin();
      await useAuthStore.getState().setAuth(response);
    } catch (err) {
      console.error('Dev login failed:', err);
      Alert.alert('Dev Login Failed', api.getErrorMessage(err));
    } finally {
      setDevLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.header} accessibilityRole="header">
        <Image
          source={require('@/assets/logo.png')}
          style={styles.logo}
          resizeMode="contain"
          accessibilityLabel="Juke"
        />
        <Text style={styles.subtitle}>Live audio spaces for Farcaster</Text>
      </View>
      <View style={styles.buttonContainer}>
        <SignInButton />
        {__DEV__ && (
          <Pressable onPress={devLogin} style={styles.devButton} disabled={devLoading}>
            <Text style={styles.devButtonText}>{devLoading ? 'Logging in...' : 'Dev Login'}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.main,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logo: {
    width: 280,
    height: 280,
    marginBottom: -20,
  },
  subtitle: {
    color: colors.text.secondary,
    fontSize: 16,
  },
  buttonContainer: {
    width: '100%',
    alignItems: 'center',
  },
  devButton: {
    marginTop: 24,
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.background.subtle,
  },
  devButtonText: {
    color: colors.text.secondary,
    fontSize: 14,
  },
});
