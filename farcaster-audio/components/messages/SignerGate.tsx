/**
 * Gates messaging UI on a usable Direct Cast token (design §3.3). Renders
 * children once `GET /v1/messages/status` reports the token active;
 * otherwise an "Enable messages" CTA that opens the recovery-phrase step,
 * which signs only the `generateToken` request. Also covers feature-off and
 * a failed status probe.
 */

import { useCallback, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { radii, spacing, touchTarget, typography, withAlpha } from "@/constants/theme";
import { RecoveryPhraseStep } from "@/components/auth/RecoveryPhraseStep";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { ON_ACCENT } from "@/components/messages/bubbleColors";
import {
  useMessagingAccess,
  type MessagingEnableReason,
} from "@/hooks/useMessagingAccess";
import { useAuthStore } from "@/stores/authStore";
import { useMessageStore } from "@/stores/messageStore";

interface SignerGateProps {
  children: ReactNode;
}

const GATE_COPY: Record<MessagingEnableReason, { title: string; body: string }> = {
  missing: {
    title: "Enable messages",
    body: "Direct Casts need a one-time approval from your Farcaster account. Enter your recovery phrase once and your chats show up here.",
  },
  expired: {
    title: "Messaging access expired",
    body: "Your Direct Cast access lasts 90 days. Approve again with your recovery phrase to keep chatting.",
  },
  rejected: {
    title: "Enable messages again",
    body: "Farcaster no longer accepts Juke's messaging access for your account. Approve again with your recovery phrase to continue.",
  },
};

export function SignerGate({ children }: SignerGateProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const availability = useMessageStore((s) => s.availability);
  const username = useAuthStore((s) => s.user?.username) ?? "";
  const {
    state,
    enableReason,
    isEnabling,
    enableError,
    enable,
    refresh,
    clearEnableError,
  } = useMessagingAccess();
  const [isEnteringPhrase, setIsEnteringPhrase] = useState(false);

  const handleStart = useCallback(() => {
    clearEnableError();
    setIsEnteringPhrase(true);
  }, [clearEnableError]);

  const handleCancel = useCallback(() => {
    clearEnableError();
    setIsEnteringPhrase(false);
  }, [clearEnableError]);

  const handleSubmitPhrase = useCallback(
    (phrase: string) => {
      void enable(phrase).then((isEnabled) => {
        if (isEnabled) setIsEnteringPhrase(false);
      });
    },
    [enable],
  );

  if (availability === "unavailable") {
    return (
      <View style={styles.container} testID="messages-unavailable">
        <Ionicons name="chatbubbles-outline" size={44} color={colors.purple} />
        <Text style={styles.title}>Messages are on their way</Text>
        <Text style={styles.body}>
          Direct messages aren't switched on yet. Check back soon.
        </Text>
      </View>
    );
  }

  if (state === "checking") {
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.purple} />
      </View>
    );
  }

  if (state === "ready") return <>{children}</>;

  if (state === "error") {
    return (
      <View style={styles.container} testID="messages-access-error">
        <Ionicons name="cloud-offline-outline" size={44} color={colors.purple} />
        <Text style={styles.title}>Messages couldn't load</Text>
        <Text style={styles.body}>Check your connection and try again.</Text>
        <Pressable
          onPress={() => void refresh()}
          style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
          accessibilityRole="button"
          testID="messages-access-retry"
        >
          <Text style={styles.primaryLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  if (isEnabling) {
    return (
      <View style={styles.container} testID="enable-messages-progress">
        <ActivityIndicator color={colors.purple} />
        <Text style={styles.body}>Enabling messages…</Text>
      </View>
    );
  }

  if (isEnteringPhrase) {
    return (
      <View style={styles.phraseContainer} testID="enable-messages-phrase">
        <RecoveryPhraseStep
          username={username}
          purpose="messages"
          error={enableError}
          onSubmit={handleSubmitPhrase}
          onCancel={handleCancel}
        />
      </View>
    );
  }

  const copy = GATE_COPY[enableReason ?? "missing"];

  return (
    <View style={styles.container} testID="signer-gate">
      <View style={styles.iconWrap}>
        <Ionicons name="key-outline" size={30} color={colors.purple} />
      </View>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.body}>{copy.body}</Text>
      {enableError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {enableError}
        </Text>
      ) : null}
      <Pressable
        onPress={handleStart}
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
        accessibilityRole="button"
        testID="signer-gate-enable"
      >
        <Text style={styles.primaryLabel}>Enable messages</Text>
      </Pressable>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: spacing["3xl"],
      gap: spacing.md,
      backgroundColor: colors.background.main,
    },
    iconWrap: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: withAlpha(colors.purple, 0.15),
      marginBottom: spacing.xs,
    },
    title: {
      fontSize: typography.size["2xl"] - 2,
      fontWeight: typography.weight.bold,
      color: colors.text.primary,
      textAlign: "center",
    },
    body: {
      fontSize: typography.size.md,
      lineHeight: 21,
      color: colors.text.secondary,
      textAlign: "center",
      marginBottom: spacing.sm,
    },
    primary: {
      alignSelf: "stretch",
      minHeight: touchTarget.min + 4,
      borderRadius: radii.full,
      backgroundColor: colors.purple,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryLabel: {
      color: ON_ACCENT,
      fontSize: typography.size.lg,
      fontWeight: typography.weight.semibold,
    },
    phraseContainer: {
      flex: 1,
      paddingHorizontal: spacing.lg,
      backgroundColor: colors.background.main,
    },
    error: {
      fontSize: typography.size.md,
      color: colors.error,
      textAlign: "center",
    },
    pressed: { opacity: 0.8 },
  }));
