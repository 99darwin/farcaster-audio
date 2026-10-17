import { useCallback, useEffect, useState } from "react";
import { Image, Pressable, Text, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";
import { RecoveryPhraseStep } from "@/components/auth/RecoveryPhraseStep";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import {
  useSignerLinkFlow,
  type SignerLinkMode,
} from "@/hooks/useSignerLinkFlow";
import type { FarcasterUserSummary } from "@/services/farcasterLookup";
import { getLastLinkedFid } from "@/services/storage";
import type { SignerLinkStatus } from "@/types/api";

interface SignerLinkFlowProps {
  mode: SignerLinkMode;
  initialUser?: FarcasterUserSummary;
  /** Called after the session is stored (state `done`). */
  onComplete?: () => void;
  /** Called when the user backs out of a relink. */
  onCancel?: () => void;
}

/**
 * Hypersnap sign-in: FID lookup → (auth address login | recovery-phrase link)
 * → registration progress. `mode="relink"` starts at confirm for the signed-in
 * user and always runs the phrase link.
 */
export function SignerLinkFlow({
  mode,
  initialUser,
  onComplete,
  onCancel,
}: SignerLinkFlowProps) {
  const { state, lookup, start, submitPhrase, reset } = useSignerLinkFlow({
    mode,
    initialUser,
  });

  // Returning device: jump straight to "Continue as @user".
  useEffect(() => {
    if (mode !== "login" || initialUser) return;
    let isActive = true;
    getLastLinkedFid()
      .then((fid) => {
        if (isActive && fid) void lookup(String(fid));
      })
      .catch(() => {
        // No remembered FID; stay on manual lookup.
      });
    return () => {
      isActive = false;
    };
    // Mount-only: resuming must not re-run after the user resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state.step === "done") onComplete?.();
  }, [onComplete, state.step]);

  const handleCancelPhrase = useCallback(() => {
    if (mode === "relink" && onCancel) {
      onCancel();
      return;
    }
    reset();
  }, [mode, onCancel, reset]);

  const handleSubmitPhrase = useCallback(
    (phrase: string) => {
      void submitPhrase(phrase);
    },
    [submitPhrase],
  );

  switch (state.step) {
    case "lookup":
      return <LookupStep error={state.error} onLookup={lookup} />;
    case "looking_up":
      return <ProgressStep label="Finding your account…" />;
    case "confirm":
      return (
        <ConfirmStep
          user={state.user}
          error={state.error}
          mode={mode}
          onContinue={start}
          onSwitchAccount={mode === "login" ? reset : undefined}
        />
      );
    case "signing_in":
      return <ProgressStep label={`Signing in as @${state.user.username}…`} />;
    case "preparing":
      return <ProgressStep label="Preparing a secure link…" />;
    case "phrase":
      return (
        <RecoveryPhraseStep
          username={state.user.username}
          error={state.error}
          onSubmit={handleSubmitPhrase}
          onCancel={handleCancelPhrase}
        />
      );
    case "registering":
      return <ProgressStep label="Signing approvals on this device…" />;
    case "waiting":
      return (
        <ProgressStep
          label={describeLinkStatus(state.linkStatus)}
          detail="This usually takes under a minute. Keep Juke open."
        />
      );
    case "done":
      return <ProgressStep label="Signed in" />;
  }
}

function describeLinkStatus(status: SignerLinkStatus): string {
  switch (status) {
    case "pending":
      return "Sending approvals to Optimism…";
    case "submitted":
      return "Waiting for the network to confirm…";
    case "approved":
      return "Approved. Signing you in…";
    case "failed":
      return "Linking failed";
  }
}

function LookupStep({
  error,
  onLookup,
}: {
  error: string | null;
  onLookup: (query: string) => void;
}) {
  const styles = useStyles();
  const [query, setQuery] = useState("");
  const canSubmit = query.trim().length > 0;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onLookup(query);
  }, [canSubmit, onLookup, query]);

  return (
    <View style={styles.step}>
      <Text style={styles.label}>Farcaster username or FID</Text>
      <TextInput
        testID="fid-lookup-input"
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={handleSubmit}
        placeholder="@username or 12345"
        placeholderTextColor={styles.placeholder.color}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="next"
        accessibilityLabel="Farcaster username or FID"
      />
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Pressable
        testID="fid-lookup-submit"
        onPress={handleSubmit}
        disabled={!canSubmit}
        style={[styles.primaryButton, !canSubmit && styles.disabled]}
        accessibilityRole="button"
        accessibilityState={{ disabled: !canSubmit }}
      >
        <Text style={styles.primaryButtonText}>Continue</Text>
      </Pressable>
    </View>
  );
}

function ConfirmStep({
  user,
  error,
  mode,
  onContinue,
  onSwitchAccount,
}: {
  user: FarcasterUserSummary;
  error: string | null;
  mode: SignerLinkMode;
  onContinue: () => void;
  onSwitchAccount?: () => void;
}) {
  const styles = useStyles();
  return (
    <View style={styles.step}>
      <View style={styles.userCard}>
        {user.pfpUrl ? (
          <Image
            source={{ uri: user.pfpUrl }}
            style={styles.avatar}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View style={[styles.avatar, styles.avatarPlaceholder]} />
        )}
        <View style={styles.userText}>
          {user.displayName ? (
            <Text style={styles.displayName} numberOfLines={1}>
              {user.displayName}
            </Text>
          ) : null}
          <Text style={styles.username} numberOfLines={1}>
            @{user.username} · FID {user.fid}
          </Text>
        </View>
      </View>
      {mode === "relink" ? (
        <Text style={styles.body}>
          Juke can&apos;t post for this account yet. Link it once with your
          Farcaster recovery phrase to cast, react and follow from Juke.
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <Pressable
        testID="signer-link-continue"
        onPress={onContinue}
        style={styles.primaryButton}
        accessibilityRole="button"
      >
        <Text style={styles.primaryButtonText}>
          {mode === "relink" ? "Link Juke" : `Continue as @${user.username}`}
        </Text>
      </Pressable>
      {onSwitchAccount ? (
        <Pressable
          onPress={onSwitchAccount}
          style={styles.secondaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>
            Use a different account
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ProgressStep({ label, detail }: { label: string; detail?: string }) {
  const styles = useStyles();
  return (
    <View
      style={[styles.step, styles.centered]}
      accessibilityLiveRegion="polite"
    >
      <LoadingSpinner />
      <Text style={styles.progressLabel}>{label}</Text>
      {detail ? <Text style={styles.body}>{detail}</Text> : null}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    step: { width: "100%", gap: 12 },
    centered: { alignItems: "center", paddingVertical: 24 },
    label: { color: colors.text.secondary, fontSize: 14 },
    body: {
      color: colors.text.body,
      fontSize: 15,
      lineHeight: 21,
      textAlign: "center",
    },
    input: {
      height: 48,
      borderWidth: 1,
      borderColor: colors.background.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      color: colors.text.primary,
      backgroundColor: colors.background.surface,
      fontSize: 16,
    },
    placeholder: { color: colors.text.placeholder },
    error: { color: colors.error, fontSize: 14 },
    primaryButton: {
      height: 48,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
      backgroundColor: colors.purple,
    },
    primaryButtonText: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
    disabled: { opacity: 0.5 },
    secondaryButton: { paddingVertical: 12, alignItems: "center" },
    secondaryButtonText: { color: colors.text.secondary, fontSize: 15 },
    userCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      padding: 12,
      borderRadius: 16,
      backgroundColor: colors.background.surface,
    },
    avatar: { width: 48, height: 48, borderRadius: 24 },
    avatarPlaceholder: { backgroundColor: colors.background.subtle },
    userText: { flex: 1 },
    displayName: {
      color: colors.text.primary,
      fontSize: 16,
      fontWeight: "600",
    },
    username: { color: colors.text.secondary, fontSize: 14 },
    progressLabel: {
      color: colors.text.primary,
      fontSize: 16,
      fontWeight: "600",
      textAlign: "center",
    },
  }));
