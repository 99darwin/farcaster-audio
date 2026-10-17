import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import * as Clipboard from "expo-clipboard";
import { usePreventScreenCapture } from "expo-screen-capture";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { countPhraseWords } from "@/services/signerLink";
import { enterSensitiveScreen } from "@/utils/sentryScrub";

/** A single change this large can only be a paste, not typing. */
const PASTE_DETECTION_MIN_CHARS = 12;
const SCREEN_CAPTURE_KEY = "recovery-phrase";

/** What the phrase signs: the full signer link, or only messaging access. */
export type RecoveryPhrasePurpose = "link" | "messages";

const PURPOSE_COPY: Record<
  RecoveryPhrasePurpose,
  { title: (username: string) => string; intro: string; usage: string; submit: string }
> = {
  link: {
    title: (username) => `Link Juke to @${username}`,
    intro: "approve Juke for this account. You only do this once per device.",
    usage:
      "The phrase is used on this phone to sign Juke's approvals (including access to your Direct Casts), then forgotten.",
    submit: "Approve Juke",
  },
  messages: {
    title: (username) => `Enable messages for @${username}`,
    intro: "let Juke read and send your Direct Casts. Access lasts 90 days.",
    usage:
      "The phrase is used on this phone to sign one messaging approval, then forgotten.",
    submit: "Enable messages",
  },
};

interface RecoveryPhraseStepProps {
  username: string;
  /** Defaults to the signer link copy. */
  purpose?: RecoveryPhrasePurpose;
  error: string | null;
  /** Receives the phrase by value; this component has already forgotten it. */
  onSubmit: (phrase: string) => void;
  onCancel: () => void;
}

/**
 * Secure entry for the Farcaster recovery phrase (auth contract §5).
 *
 * - Screenshots / screen recording are blocked while mounted.
 * - Secure text entry; autocorrect, suggestions, spellcheck and autofill off.
 * - The phrase lives only in this component's state. It is cleared the moment
 *   the user submits, when the app is backgrounded, and on unmount.
 * - Sentry drops all breadcrumbs while this screen is mounted.
 * - Nothing here logs; a pasted phrase is wiped from the clipboard on submit.
 */
export function RecoveryPhraseStep({
  username,
  purpose = "link",
  error,
  onSubmit,
  onCancel,
}: RecoveryPhraseStepProps) {
  const styles = useStyles();
  const copy = PURPOSE_COPY[purpose];
  usePreventScreenCapture(SCREEN_CAPTURE_KEY);
  useEffect(() => enterSensitiveScreen(), []);

  const [phrase, setPhrase] = useState("");
  const wasPastedRef = useRef(false);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next !== "active") setPhrase("");
    });
    return () => subscription.remove();
  }, []);

  const handleChangeText = useCallback((text: string) => {
    setPhrase((previous) => {
      if (text.length - previous.length >= PASTE_DETECTION_MIN_CHARS) {
        wasPastedRef.current = true;
      }
      return text;
    });
  }, []);

  const wordCount = countPhraseWords(phrase);
  const canSubmit = wordCount > 0;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    const value = phrase;
    setPhrase("");
    if (wasPastedRef.current) {
      wasPastedRef.current = false;
      Clipboard.setStringAsync("").catch(() => {
        // Best effort; nothing else to do and nothing to log.
      });
    }
    onSubmit(value);
  }, [canSubmit, onSubmit, phrase]);

  const handleCancel = useCallback(() => {
    setPhrase("");
    onCancel();
  }, [onCancel]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title} accessibilityRole="header">
          {copy.title(username)}
        </Text>
        <Text style={styles.body}>
          Enter your{" "}
          <Text style={styles.strong}>Farcaster recovery phrase</Text> to{" "}
          {copy.intro}
        </Text>
        <View style={styles.callout}>
          <Text style={styles.calloutTitle}>Not your wallet phrase</Text>
          <Text style={styles.calloutBody}>
            Use the recovery phrase for your Farcaster account (in the Farcaster
            app: Settings → Advanced → Farcaster recovery phrase). The phrase
            for your Farcaster wallet is a different key and won&apos;t work.
          </Text>
        </View>
        <Text style={styles.body}>
          {copy.usage} It is never saved and never sent to Juke or anyone else.
        </Text>

        <TextInput
          testID="recovery-phrase-input"
          accessibilityLabel="Farcaster recovery phrase"
          style={styles.input}
          value={phrase}
          onChangeText={handleChangeText}
          onSubmitEditing={handleSubmit}
          placeholder="word1 word2 word3 …"
          placeholderTextColor={styles.placeholder.color}
          secureTextEntry
          autoCorrect={false}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          textContentType="none"
          importantForAutofill="no"
          returnKeyType="done"
          blurOnSubmit
        />
        <Text style={styles.counter} accessibilityLiveRegion="polite">
          {wordCount} {wordCount === 1 ? "word" : "words"}
        </Text>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <Pressable
          testID="recovery-phrase-submit"
          onPress={handleSubmit}
          disabled={!canSubmit}
          style={[styles.primaryButton, !canSubmit && styles.disabled]}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canSubmit }}
        >
          <Text style={styles.primaryButtonText}>{copy.submit}</Text>
        </Pressable>
        <Pressable
          onPress={handleCancel}
          style={styles.secondaryButton}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    flex: { flex: 1, width: "100%" },
    container: { paddingVertical: 16, gap: 12 },
    title: { color: colors.text.primary, fontSize: 20, fontWeight: "700" },
    body: { color: colors.text.body, fontSize: 15, lineHeight: 21 },
    strong: { fontWeight: "700", color: colors.text.primary },
    callout: {
      borderWidth: 1,
      borderColor: colors.warning,
      borderRadius: 12,
      padding: 12,
      gap: 4,
      backgroundColor: colors.background.surface,
    },
    calloutTitle: { color: colors.warning, fontSize: 14, fontWeight: "700" },
    calloutBody: { color: colors.text.body, fontSize: 14, lineHeight: 20 },
    input: {
      minHeight: 48,
      borderWidth: 1,
      borderColor: colors.background.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      color: colors.text.primary,
      backgroundColor: colors.background.surface,
      fontSize: 16,
    },
    placeholder: { color: colors.text.placeholder },
    counter: { color: colors.text.secondary, fontSize: 13 },
    error: { color: colors.error, fontSize: 14 },
    primaryButton: {
      height: 48,
      borderRadius: 20,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.purple,
    },
    primaryButtonText: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
    disabled: { opacity: 0.5 },
    secondaryButton: { paddingVertical: 12, alignItems: "center" },
    secondaryButtonText: { color: colors.text.secondary, fontSize: 15 },
  }));
