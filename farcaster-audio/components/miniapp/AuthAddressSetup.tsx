import { useCallback, useState } from "react";
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useAuthStore } from "@/stores/authStore";
import { useMiniAppStore } from "@/stores/miniappStore";
import { getAuthAddressStatus } from "@/services/authAddress";
import { typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

type Step = "intro" | "checking";

/**
 * Shown when a mini app asks to sign in but this device's auth address isn't
 * in KeyRegistry yet. The only way to add it is the one-time recovery-phrase
 * link (`/link-signer`), so this prompt hands off there; it never registers
 * a key itself (the old Neynar approval endpoint is gone).
 */
export function AuthAddressSetup() {
  const { colors } = useTheme();
  const styles = useStyles();
  const router = useRouter();
  const showAuthSetup = useMiniAppStore((s) => s.showAuthSetup);
  const dismissAuthSetup = useMiniAppStore((s) => s.dismissAuthSetup);
  const minimizeMiniApp = useMiniAppStore((s) => s.minimizeMiniApp);
  const user = useAuthStore((s) => s.user);
  const [step, setStep] = useState<Step>("intro");
  const [notice, setNotice] = useState<string | null>(null);

  const handleLink = useCallback(() => {
    // Sign-in is declined for now; the mini app can ask again after linking.
    dismissAuthSetup(false);
    minimizeMiniApp();
    router.push("/link-signer");
  }, [dismissAuthSetup, minimizeMiniApp, router]);

  const handleCheckAgain = useCallback(async () => {
    if (!user?.fid) return;
    setStep("checking");
    const status = await getAuthAddressStatus(user.fid, { force: true });
    if (status === "approved") {
      setNotice(null);
      setStep("intro");
      dismissAuthSetup(true);
      return;
    }
    setNotice("This device isn't linked yet.");
    setStep("intro");
  }, [dismissAuthSetup, user?.fid]);

  const handleCancel = useCallback(() => {
    setNotice(null);
    dismissAuthSetup(false);
  }, [dismissAuthSetup]);

  if (!showAuthSetup) return null;

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        {step === "checking" ? (
          <ActivityIndicator size="large" color={colors.purple} />
        ) : (
          <>
            <View style={styles.iconContainer}>
              <Ionicons name="key-outline" size={32} color={colors.purple} />
            </View>
            <Text style={styles.title}>Sign In Required</Text>
            <Text style={styles.description}>
              This mini app needs to verify your identity. Link Juke to your
              Farcaster account once with your recovery phrase, then try again.
            </Text>
            {notice ? <Text style={styles.subtitle}>{notice}</Text> : null}
            <Pressable onPress={handleLink} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>Link Juke</Text>
            </Pressable>
            <Pressable onPress={handleCheckAgain} style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>I already linked</Text>
            </Pressable>
            <Pressable onPress={handleCancel} style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Not Now</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    overlay: {
      ...StyleSheet.absoluteFillObject,
      zIndex: 200,
      backgroundColor: "rgba(0, 0, 0, 0.7)",
      justifyContent: "center",
      alignItems: "center",
      padding: 24,
    },
    card: {
      backgroundColor: colors.background.surface,
      borderRadius: 20,
      padding: 28,
      width: "100%",
      maxWidth: 340,
      alignItems: "center",
      gap: 12,
    },
    iconContainer: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: "rgba(138, 99, 210, 0.15)",
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 4,
    },
    title: {
      color: colors.text.primary,
      fontSize: typography.size.lg,
      fontWeight: typography.weight.semibold,
      textAlign: "center",
    },
    subtitle: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
      textAlign: "center",
    },
    description: {
      color: colors.text.body,
      fontSize: typography.size.md,
      textAlign: "center",
      lineHeight: 22,
    },
    primaryBtn: {
      backgroundColor: colors.purple,
      paddingHorizontal: 32,
      paddingVertical: 14,
      borderRadius: 12,
      width: "100%",
      alignItems: "center",
      marginTop: 8,
    },
    primaryBtnText: {
      color: colors.text.primary,
      fontSize: typography.size.md,
      fontWeight: typography.weight.semibold,
    },
    secondaryBtn: {
      paddingHorizontal: 32,
      paddingVertical: 10,
      width: "100%",
      alignItems: "center",
    },
    secondaryBtnText: {
      color: colors.text.secondary,
      fontSize: typography.size.md,
    },
  }));
