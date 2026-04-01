import { useState, useRef, useEffect } from 'react';
import { View, Text, Pressable, Linking, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuthStore } from '@/stores/authStore';
import { useMiniAppStore } from '@/stores/miniappStore';
import { registerAuthAddress, getAuthAddressStatus } from '@/services/authAddress';
import { colors, typography } from '@/constants/theme';

type Step = 'intro' | 'registering' | 'approval' | 'polling' | 'done' | 'error';

export function AuthAddressSetup() {
  const showAuthSetup = useMiniAppStore((s) => s.showAuthSetup);
  const dismissAuthSetup = useMiniAppStore((s) => s.dismissAuthSetup);
  const user = useAuthStore((s) => s.user);
  const [step, setStep] = useState<Step>('intro');
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const mountedRef = useRef<boolean>(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!showAuthSetup) return null;

  const handleSetup = async () => {
    if (!user?.fid) return;
    setStep('registering');

    try {
      const result = await registerAuthAddress(user.fid);

      if (result.status === 'approved') {
        if (!mountedRef.current) return;
        setStep('done');
        timerRef.current = setTimeout(() => {
          if (mountedRef.current) dismissAuthSetup(true);
        }, 1500);
        return;
      }

      if (result.approvalUrl) {
        setApprovalUrl(result.approvalUrl);
        setStep('approval');
      } else {
        setErrorMsg('No approval URL returned');
        setStep('error');
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Registration failed');
      setStep('error');
    }
  };

  const handleOpenApproval = async () => {
    if (approvalUrl) {
      await Linking.openURL(approvalUrl);
      setStep('polling');
      pollForApproval();
    }
  };

  const pollForApproval = async () => {
    if (!user?.fid) return;
    const maxAttempts = 30;
    for (let i = 0; i < maxAttempts; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      if (!mountedRef.current) return;
      const status = await getAuthAddressStatus(user.fid);
      if (!mountedRef.current) return;
      if (status === 'approved') {
        setStep('done');
        timerRef.current = setTimeout(() => {
          if (mountedRef.current) dismissAuthSetup(true);
        }, 1500);
        return;
      }
    }
    if (!mountedRef.current) return;
    setErrorMsg('Approval timed out. Please try again.');
    setStep('error');
  };

  const handleCancel = () => {
    dismissAuthSetup(false);
  };

  return (
    <View style={styles.overlay}>
      <View style={styles.card}>
        {step === 'intro' && (
          <>
            <View style={styles.iconContainer}>
              <Ionicons name="key-outline" size={32} color={colors.purple} />
            </View>
            <Text style={styles.title}>Sign In Required</Text>
            <Text style={styles.description}>
              This mini app needs to verify your identity. We'll create a secure signing key on your device and register it with your Farcaster account.
            </Text>
            <Text style={styles.subtitle}>
              You'll need to approve once in Warpcast.
            </Text>
            <Pressable onPress={handleSetup} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>Set Up</Text>
            </Pressable>
            <Pressable onPress={handleCancel} style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Not Now</Text>
            </Pressable>
          </>
        )}

        {step === 'registering' && (
          <>
            <ActivityIndicator size="large" color={colors.purple} />
            <Text style={styles.title}>Registering...</Text>
            <Text style={styles.description}>
              Creating your signing key and registering with Farcaster.
            </Text>
          </>
        )}

        {step === 'approval' && (
          <>
            <View style={styles.iconContainer}>
              <Ionicons name="open-outline" size={32} color={colors.purple} />
            </View>
            <Text style={styles.title}>Approve in Warpcast</Text>
            <Text style={styles.description}>
              Tap the button below to open Warpcast and approve the signing key. This is a one-time step.
            </Text>
            <Pressable onPress={handleOpenApproval} style={styles.primaryBtn}>
              <Text style={styles.primaryBtnText}>Open Warpcast</Text>
            </Pressable>
            <Pressable onPress={handleCancel} style={styles.secondaryBtn}>
              <Text style={styles.secondaryBtnText}>Cancel</Text>
            </Pressable>
          </>
        )}

        {step === 'polling' && (
          <>
            <ActivityIndicator size="large" color={colors.purple} />
            <Text style={styles.title}>Waiting for Approval</Text>
            <Text style={styles.description}>
              Complete the approval in Warpcast, then come back here. This will update automatically.
            </Text>
          </>
        )}

        {step === 'done' && (
          <>
            <View style={styles.iconContainer}>
              <Ionicons name="checkmark-circle" size={40} color={colors.success} />
            </View>
            <Text style={styles.title}>All Set</Text>
            <Text style={styles.description}>
              Your signing key is registered. Mini apps can now authenticate you.
            </Text>
          </>
        )}

        {step === 'error' && (
          <>
            <View style={styles.iconContainer}>
              <Ionicons name="alert-circle-outline" size={32} color={colors.error} />
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

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 200,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  card: {
    backgroundColor: colors.background.surface,
    borderRadius: 20,
    padding: 28,
    width: '100%',
    maxWidth: 340,
    alignItems: 'center',
    gap: 12,
  },
  iconContainer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(138, 99, 210, 0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.lg,
    fontWeight: typography.weight.semibold,
    textAlign: 'center',
  },
  subtitle: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
    textAlign: 'center',
  },
  description: {
    color: colors.text.body,
    fontSize: typography.size.md,
    textAlign: 'center',
    lineHeight: 22,
  },
  primaryBtn: {
    backgroundColor: colors.purple,
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 12,
    width: '100%',
    alignItems: 'center',
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
    width: '100%',
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: colors.text.secondary,
    fontSize: typography.size.md,
  },
});
