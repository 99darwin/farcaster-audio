import { useState } from "react";
import {
  Alert,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { Redirect } from "expo-router";
import { SignerLinkFlow } from "@/components/auth/SignerLinkFlow";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { useAuth } from "@/hooks/useAuth";
import { useAuthStore } from "@/stores/authStore";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import * as api from "@/services/api";

export default function LoginScreen() {
  const { isAuthenticated, isLoading } = useAuth();
  const [devLoading, setDevLoading] = useState(false);
  const styles = useStyles();

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
      Alert.alert("Dev Login Failed", api.getErrorMessage(err));
    } finally {
      setDevLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.header} accessibilityRole="header">
        <Image
          source={require("@/assets/logo.png")}
          style={styles.logo}
          resizeMode="contain"
          accessibilityLabel="Juke"
        />
        <Text style={styles.subtitle}>Live audio spaces for Farcaster</Text>
      </View>
      <View style={styles.flowContainer}>
        <SignerLinkFlow mode="login" />
        <Pressable
          onPress={devLogin}
          style={styles.devButton}
          disabled={devLoading}
        >
          <Text style={styles.devButtonText}>
            {devLoading ? "Logging in..." : "Demo Login"}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      backgroundColor: colors.background.main,
      justifyContent: "center",
      alignItems: "center",
      paddingHorizontal: 32,
    },
    header: {
      alignItems: "center",
      marginBottom: 24,
    },
    logo: {
      width: 220,
      height: 220,
      marginBottom: -16,
    },
    subtitle: {
      color: colors.text.secondary,
      fontSize: 16,
    },
    flowContainer: {
      width: "100%",
      maxWidth: 420,
      alignItems: "center",
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
  }));
