import { useState, useRef, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  Linking,
  StyleSheet,
  ActivityIndicator,
  AppState,
  type AppStateStatus,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useAuthStore } from "@/stores/authStore";
import { useMiniAppStore } from "@/stores/miniappStore";
import {
  registerAuthAddress,
  getAuthAddressStatus,
} from "@/services/authAddress";
import { typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";

type Step = "intro" | "registering" | "approval" | "polling" | "done" | "error";

/** Hard cap for the AppState approval watcher. */
const APPROVAL_WATCH_MAX_MS = 10 * 60 * 1000;

export function AuthAddressSetup() {
  const { colors } = useTheme();
  const styles = useStyles();
  const showAuthSetup = useMiniAppStore((s) => s.showAuthSetup);
  const dismissAuthSetup = useMiniAppStore((s) => s.dismissAuthSetup);
  const user = useAuthStore((s) => s.user);
  const [step, setStep] = useState<Step>("intro");
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const mountedRef = useRef<boolean>(true);
  const doneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (doneTimerRef.current) clearTimeout(doneTimerRef.current);
      if (appStateCleanupRef.current) appStateCleanupRef.current();
    };
  }, []);

  const finishApproved = useCallback(() => {
    if (!mountedRef.current) return;
    setStep("done");
    doneTimerRef.current = setTimeout(() => {
      if (mountedRef.current) dismissAuthSetup(true);
    }, 1500);
  }, [dismissAuthSetup]);

  /**
   * Subscribe to AppState transitions back to 'active' and fire a single
   * status check per transition. Auto-unsubscribes on approval, on
   * component unmount, or after APPROVAL_WATCH_MAX_MS — no timed polling.
   */
  const startApprovalWatch = useCallback(() => {
    if (appStateCleanupRef.current) {
      appStateCleanupRef.current();
      appStateCleanupRef.current = null;
    }
    const fid = user?.fid;
    if (!fid) return;

    let cancelled = false;

    const cleanup = () => {
      if (cancelled) return;
      cancelled = true;
      clearTimeout(timeout);
      subscription.remove();
      if (appStateCleanupRef.current === cleanup) {
        appStateCleanupRef.current = null;
      }
    };

    const subscription = AppState.addEventListener(
      "change",
      (next: AppStateStatus) => {
        if (cancelled) return;
        if (next !== "active") return;
        void getAuthAddressStatus(fid, { force: true }).then((status) => {
          if (cancelled || !mountedRef.current) return;
          if (status === "approved") {
            cleanup();
            finishApproved();
          }
        });
      },
    );

    const timeout = setTimeout(() => {
      if (!mountedRef.current) {
        cleanup();
        return;
      }
      cleanup();
      setErrorMsg("Approval timed out. Please try again.");
      setStep("error");
    }, APPROVAL_WATCH_MAX_MS);

    appStateCleanupRef.current = cleanup;
  }, [user?.fid, finishApproved]);

  const handleManualCheck = useCallback(async () => {
    if (!user?.fid) return;
    const status = await getAuthAddressStatus(user.fid, { force: true });
    if (!mountedRef.current) return;
    if (status === "approved") {
      if (appStateCleanupRef.current) appStateCleanupRef.current();
      finishApproved();
    }
  }, [user?.fid, finishApproved]);

  if (!showAuthSetup) return null;

  const handleSetup = async () => {
    if (!user?.fid) return;
    setStep("registering");

    try {
      const result = await registerAuthAddress(user.fid);

      if (result.status === "approved") {
        finishApproved();
        return;
      }

      if (result.approvalUrl) {
        setApprovalUrl(result.approvalUrl);
        setStep("approval");
      } else {
        setErrorMsg("No approval URL returned");
        setStep("error");
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Registration failed");
      setStep("error");
    }
  };

  const handleOpenApproval = async () => {
    if (approvalUrl) {
      await Linking.openURL(approvalUrl);
      setStep("polling");
      startApprovalWatch();
    }
  };

  const handleCancel = () => {
    dismissAuthSetup(false);
  };

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        {step === "intro" && (
          <>
            <View style={styles.iconContainer}>
              <Ionicons name="key-outline" size={32} color={colors.purple} />
            </View>
            <Text style={styles.title}>Sign In Required</Text>
            <Text style={styles.description}>
              This mini app needs to verify your identity. We'll create a secure
              signing key on your device and register it with your Farcaster
              account.
            </Text>
            <Text style={styles.subtitle}>
              You'll need to approve once in Farcaster.
            </Text>
            <Pressable onPress={handleSetup} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>Set Up</Text>
            </Pressable>
            <Pressable onPress={handleCancel} style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Not Now</Text>
            </Pressable>
          </>
        )}

        {step === "registering" && (
          <>
            <ActivityIndicator size="large" color={colors.purple} />
            <Text style={styles.title}>Registering...</Text>
            <Text style={styles.description}>
              Creating your signing key and registering with Farcaster.
            </Text>
          </>
        )}

        {step === "approval" && (
          <>
            <View style={styles.iconContainer}>
              <Ionicons name="open-outline" size={32} color={colors.purple} />
            </View>
            <Text style={styles.title}>Approve in Farcaster</Text>
            <Text style={styles.description}>
              Tap the button below to open Farcaster and approve the signing
              key. This is a one-time step.
            </Text>
            <Pressable onPress={handleOpenApproval} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>Open Farcaster</Text>
            </Pressable>
            <Pressable onPress={handleCancel} style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </Pressable>
          </>
        )}

        {step === "polling" && (
          <>
            <ActivityIndicator size="large" color={colors.purple} />
            <Text style={styles.title}>Waiting for Approval</Text>
            <Text style={styles.description}>
              Complete the approval in Farcaster, then come back here. This will
              update automatically.
            </Text>
            <Pressable onPress={handleManualCheck} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>I approved it</Text>
            </Pressable>
            <Pressable onPress={handleCancel} style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </Pressable>
          </>
        )}

        {step === "done" && (
          <>
            <View style={styles.iconContainer}>
              <Ionicons
                name="checkmark-circle"
                size={40}
                color={colors.success}
              />
            </View>
            <Text style={styles.title}>All Set</Text>
            <Text style={styles.description}>
              Your signing key is registered. Mini apps can now authenticate
              you.
            </Text>
          </>
        )}

        {step === "error" && (
          <>
            <View style={styles.iconContainer}>
              <Ionicons
                name="alert-circle-outline"
                size={32}
                color={colors.error}
              />
            </View>
            <Text style={styles.title}>Something Went Wrong</Text>
            <Text style={styles.description}>{errorMsg}</Text>
            <Pressable onPress={handleSetup} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>Try Again</Text>
            </Pressable>
            <Pressable onPress={handleCancel} style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Cancel</Text>
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
