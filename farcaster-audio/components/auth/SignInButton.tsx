import { useState } from 'react';
import { View, StyleSheet, Alert } from 'react-native';
import { NeynarSigninButton } from '@neynar/react-native-signin';
import Constants from 'expo-constants';
import { useAuth } from '@/hooks/useAuth';
import * as api from '@/services/api';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';

export function SignInButton() {
  const { login } = useAuth();
  const [isSigningIn, setIsSigningIn] = useState(false);

  const fetchAuthorizationUrl = async () => {
    const { authorization_url } = await api.getAuthUrl();
    return authorization_url;
  };

  const handleSuccess = async (data: { signer_uuid: string; fid: string }) => {
    setIsSigningIn(true);
    try {
      await login(data.signer_uuid, Number(data.fid));
    } catch (error) {
      Alert.alert('Sign In Failed', 'Could not complete sign in. Please try again.');
    } finally {
      setIsSigningIn(false);
    }
  };

  const handleError = (error: Error) => {
    console.error('SIWN error:', error);
    Alert.alert('Sign In Error', error.message || 'An error occurred during sign in.');
  };

  // In dev, use the Expo dev server URL; in prod, use the custom scheme
  const debuggerHost = Constants.expoConfig?.hostUri ?? Constants.manifest2?.extra?.expoGo?.debuggerHost;
  const redirectUrl = __DEV__ && debuggerHost
    ? `exp://${debuggerHost}`
    : 'farcaster-audio://auth/callback';

  if (isSigningIn) {
    return (
      <View style={styles.loadingContainer}>
        <LoadingSpinner />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <NeynarSigninButton
        fetchAuthorizationUrl={fetchAuthorizationUrl}
        successCallback={handleSuccess}
        errorCallback={handleError}
        redirectUrl={redirectUrl}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingContainer: {
    padding: 20,
    alignItems: 'center',
  },
});
