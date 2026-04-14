import { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  Alert,
  Pressable,
  Modal,
  SafeAreaView,
  Linking,
} from "react-native";
import WebView, { WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";
import * as Haptics from "expo-haptics";
import { useAuth } from "@/hooks/useAuth";
import * as api from "@/services/api";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { colors } from "@/constants/theme";

// Injected into the WebView before Neynar's page loads:
// 1. Spoof document.referrer so Neynar's page accepts the WebView context
// 2. Shim window.opener — Neynar's SIWN page calls window.opener.postMessage()
//    to send auth data back, but window.opener is null in a WebView.
//    This bridges it to ReactNativeWebView.postMessage() instead.
const INJECTED_JS_BEFORE_LOAD = `
(function() {
  Object.defineProperty(Document.prototype, 'referrer', {
    get: function() { return 'https://app.neynar.com/'; }
  });

  if (!window.opener) {
    window.opener = {
      postMessage: function(data) {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(
            typeof data === 'string' ? data : JSON.stringify(data)
          );
        }
      }
    };
  }

  window.addEventListener('message', function(event) {
    try {
      var raw = event.data;
      var data = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (data && data.is_authenticated && data.signer_uuid) {
        window.ReactNativeWebView.postMessage(JSON.stringify(data));
      }
    } catch(e) {}
  });
})();
true;
`;

export function SignInButton() {
  const { login } = useAuth();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);

  const handlePress = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      const { authorization_url } = await api.getAuthUrl();
      const url = `${authorization_url}&deeplink_url=${encodeURIComponent("juke://auth/callback")}`;
      setAuthUrl(url);
      setModalVisible(true);
    } catch (error) {
      Alert.alert(
        "Sign In Error",
        "Could not start sign in. Please try again.",
      );
    }
  }, []);

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);
        if (!data.signer_uuid || !data.fid) return;

        setModalVisible(false);
        setIsSigningIn(true);
        await login(data.signer_uuid, Number(data.fid));
      } catch (error) {
        Alert.alert(
          "Sign In Failed",
          "Could not complete sign in. Please try again.",
        );
      } finally {
        setIsSigningIn(false);
      }
    },
    [login],
  );

  const handleShouldStartLoad = useCallback(
    (event: ShouldStartLoadRequest): boolean => {
      // Intercept deep link redirects with auth data
      if (event.url.startsWith("juke://")) {
        try {
          const url = new URL(event.url);
          const signerUuid = url.searchParams.get("signer_uuid");
          const fid = url.searchParams.get("fid");
          if (signerUuid && fid) {
            setModalVisible(false);
            setIsSigningIn(true);
            login(signerUuid, Number(fid))
              .catch(() =>
                Alert.alert("Sign In Failed", "Could not complete sign in."),
              )
              .finally(() => setIsSigningIn(false));
          }
        } catch {}
        return false;
      }

      if (event.url === "about:blank" || /^https?:\/\//.test(event.url)) {
        return true;
      }

      Linking.openURL(event.url).catch(() => {});
      return false;
    },
    [login],
  );

  if (isSigningIn) {
    return (
      <View style={styles.loadingContainer}>
        <LoadingSpinner />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Pressable
        onPress={handlePress}
        style={styles.button}
        accessibilityRole="button"
        accessibilityLabel="Sign in with Farcaster"
      >
        <Text style={styles.buttonText}>Sign in with Farcaster</Text>
      </Pressable>

      {modalVisible && (
        <Modal
          animationType="slide"
          transparent={false}
          visible={modalVisible}
          onRequestClose={() => setModalVisible(false)}
        >
          <SafeAreaView style={styles.modalContainer}>
            <View style={styles.closeButtonContainer}>
              <Pressable
                onPress={() => setModalVisible(false)}
                style={styles.closeButton}
                accessibilityRole="button"
                accessibilityLabel="Close sign in"
              >
                <Text style={styles.closeButtonText}>Close</Text>
              </Pressable>
            </View>
            {authUrl ? (
              <WebView
                source={{ uri: authUrl }}
                javaScriptEnabled
                domStorageEnabled
                startInLoadingState
                injectedJavaScriptBeforeContentLoaded={INJECTED_JS_BEFORE_LOAD}
                onMessage={handleMessage}
                onShouldStartLoadWithRequest={handleShouldStartLoad}
                originWhitelist={["*"]}
              />
            ) : (
              <View style={styles.loadingContainer}>
                <LoadingSpinner />
              </View>
            )}
          </SafeAreaView>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
  },
  loadingContainer: {
    padding: 20,
    alignItems: "center",
  },
  button: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 48,
    paddingHorizontal: 24,
    borderRadius: 20,
    backgroundColor: colors.purple,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: "600",
    color: colors.text.primary,
  },
  modalContainer: {
    flex: 1,
  },
  closeButtonContainer: {
    flexDirection: "row",
    justifyContent: "flex-start",
    paddingHorizontal: 10,
    paddingTop: 15,
  },
  closeButton: {
    borderWidth: 1,
    borderColor: colors.purple,
    borderRadius: 10,
    padding: 8,
    backgroundColor: colors.background.surface,
  },
  closeButtonText: {
    fontSize: 12,
    fontWeight: "bold",
    color: colors.purple,
  },
});
