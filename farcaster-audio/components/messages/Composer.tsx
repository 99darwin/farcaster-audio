/**
 * Thread composer: growing multiline input, reply preview, @mention
 * suggestions, a debounced link preview (`POST /metadata/preview`) and the
 * send button. The parent places it inside a KeyboardAvoidingView.
 *
 * With a `draftKey` the unsent text is persisted (debounced, and flushed on
 * unmount), restored when the thread opens and cleared on send.
 */

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { MentionSuggestions } from "@/components/common/MentionSuggestions";
import {
  clearComposerDraft,
  loadComposerDraft,
  saveComposerDraft,
} from "@/services/composerDrafts";
import { previewMetadata, isAbortError } from "@/services/messagesApi";
import { radii, spacing, touchTarget, typography, withAlpha } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { userDisplayName } from "@/components/messages/userDisplayName";
import { ON_ACCENT } from "@/components/messages/bubbleColors";
import { tokenizeCastText } from "@/utils/castTextTokens";
import { MAX_MESSAGE_LENGTH, type Message, type MessageUrlEmbed } from "@/types/messages";

const LINK_PREVIEW_DEBOUNCE_MS = 600;
export const DRAFT_SAVE_DEBOUNCE_MS = 400;
const INPUT_MAX_HEIGHT = 132;
const SEND_BUTTON_SIZE = 36;
/** Show the remaining-characters counter once this many are left. */
export const LENGTH_COUNTER_THRESHOLD = 200;

/** Characters left when near the limit, else null (counter hidden). */
export function remainingCharacters(text: string): number | null {
  const remaining = MAX_MESSAGE_LENGTH - text.length;
  return remaining <= LENGTH_COUNTER_THRESHOLD ? remaining : null;
}

export interface ComposerHandle {
  focus: () => void;
}

export interface ComposerSubmit {
  text: string;
  /** False when the user dismissed the link preview. */
  processMetadata: boolean;
}

interface ComposerProps {
  replyTarget: Message | null;
  isReadOnly: boolean;
  bottomInset: number;
  placeholder?: string;
  /** Storage key for the persisted draft (`composerDraftKey`); null skips it. */
  draftKey?: string | null;
  onCancelReply: () => void;
  /**
   * Resolve true when the draft can be cleared. Resolve as soon as the
   * message is accepted (optimistic insert), not when delivery finishes:
   * the composer stays busy until then.
   */
  onSubmit: (submit: ComposerSubmit) => Promise<boolean>;
}

function firstUrl(text: string): string | null {
  const url = tokenizeCastText(text).find((s) => s.type === "url");
  return url && url.type === "url" ? url.href : null;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    replyTarget,
    isReadOnly,
    bottomInset,
    placeholder = "Message",
    draftKey = null,
    onCancelReply,
    onSubmit,
  },
  ref,
) {
  const { colors } = useTheme();
  const styles = useStyles();
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [linkPreview, setLinkPreview] = useState<MessageUrlEmbed | null>(null);
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);
  const textRef = useRef(text);
  textRef.current = text;
  /** Saving waits for the restore so it can't overwrite the stored draft. */
  const hasRestoredDraftRef = useRef(draftKey === null);
  /** The user typed before the restore landed: keep what they typed. */
  const hasEditedRef = useRef(false);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  useEffect(() => {
    if (!draftKey) return;
    let isActive = true;
    void loadComposerDraft(draftKey).then((saved) => {
      if (!isActive) return;
      hasRestoredDraftRef.current = true;
      if (hasEditedRef.current) {
        void saveComposerDraft(draftKey, textRef.current);
      } else if (saved) {
        setText(saved);
        setCursorPosition(saved.length);
      }
    });
    return () => {
      isActive = false;
    };
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey || !hasRestoredDraftRef.current) return;
    const timer = setTimeout(() => void saveComposerDraft(draftKey, text), DRAFT_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftKey, text]);

  // Leaving the thread mid-debounce still keeps the latest text.
  useEffect(
    () => () => {
      if (draftKey && hasRestoredDraftRef.current) {
        void saveComposerDraft(draftKey, textRef.current);
      }
    },
    [draftKey],
  );

  const handleChangeText = useCallback((next: string) => {
    hasEditedRef.current = true;
    setText(next);
    setCursorPosition(next.length);
  }, []);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const show = Keyboard.addListener(showEvent, () => setIsKeyboardVisible(true));
    const hide = Keyboard.addListener(hideEvent, () => setIsKeyboardVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // Reply chosen (swipe or menu): bring the keyboard up.
  useEffect(() => {
    if (replyTarget) inputRef.current?.focus();
  }, [replyTarget]);

  const url = firstUrl(text);
  useEffect(() => {
    if (!url || url === dismissedUrl) {
      setLinkPreview(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewMetadata(url, { signal: controller.signal })
        .then((metadata) => {
          if (!controller.signal.aborted) setLinkPreview(metadata.urls[0] ?? null);
        })
        .catch((error: unknown) => {
          // Preview is decoration; never block or toast on failure.
          if (!isAbortError(error)) setLinkPreview(null);
        });
    }, LINK_PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [dismissedUrl, url]);

  const handleSelectionChange = useCallback(
    (event: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      setCursorPosition(event.nativeEvent.selection.end);
    },
    [],
  );

  const handleMentionSelect = useCallback(
    (username: string, mentionStart: number) => {
      const before = text.slice(0, mentionStart);
      const after = text.slice(cursorPosition);
      const inserted = `@${username} `;
      hasEditedRef.current = true;
      setText(before + inserted + after);
      setCursorPosition(before.length + inserted.length);
      requestAnimationFrame(() => inputRef.current?.focus());
    },
    [cursorPosition, text],
  );

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !isSubmitting && !isReadOnly;

  const handleSend = useCallback(async () => {
    if (!canSend) return;
    setIsSubmitting(true);
    // Clear immediately: the optimistic bubble already shows the text, and a
    // failed send keeps it in the thread with a retry affordance.
    const draft = text;
    setText("");
    setLinkPreview(null);
    if (draftKey) void clearComposerDraft(draftKey);
    try {
      const isCleared = await onSubmit({
        text: draft,
        processMetadata: dismissedUrl === null || dismissedUrl !== firstUrl(draft),
      });
      if (!isCleared) setText(draft);
      setDismissedUrl(null);
    } finally {
      setIsSubmitting(false);
    }
  }, [canSend, dismissedUrl, draftKey, onSubmit, text]);

  const remaining = remainingCharacters(text);

  const replyName = replyTarget
    ? userDisplayName(replyTarget.sender, "message")
    : "";

  return (
    <View
      style={[
        styles.container,
        { paddingBottom: (isKeyboardVisible ? 0 : bottomInset) + spacing.sm },
      ]}
    >
      <MentionSuggestions
        text={text}
        cursorPosition={cursorPosition}
        onSelect={handleMentionSelect}
      />
      {replyTarget ? (
        <View style={styles.attachment} testID="composer-reply-preview">
          <Ionicons name="arrow-undo" size={18} color={colors.purple} />
          <View style={styles.attachmentBody}>
            <Text style={styles.attachmentTitle} numberOfLines={1}>
              Reply to {replyName}
            </Text>
            <Text style={styles.attachmentText} numberOfLines={1}>
              {replyTarget.is_deleted ? "Message deleted" : replyTarget.text}
            </Text>
          </View>
          <Pressable
            onPress={onCancelReply}
            hitSlop={10}
            accessibilityLabel="Cancel reply"
            testID="composer-cancel-reply"
          >
            <Ionicons name="close" size={20} color={colors.text.secondary} />
          </Pressable>
        </View>
      ) : null}
      {linkPreview ? (
        <View style={styles.attachment} testID="composer-link-preview">
          <Ionicons name="link" size={18} color={colors.purple} />
          <View style={styles.attachmentBody}>
            <Text style={styles.attachmentTitle} numberOfLines={1}>
              {linkPreview.title ?? linkPreview.domain ?? linkPreview.url}
            </Text>
            <Text style={styles.attachmentText} numberOfLines={1}>
              {linkPreview.description ?? linkPreview.url}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              setDismissedUrl(url);
              setLinkPreview(null);
            }}
            hitSlop={10}
            accessibilityLabel="Remove link preview"
          >
            <Ionicons name="close" size={20} color={colors.text.secondary} />
          </Pressable>
        </View>
      ) : null}
      {isReadOnly ? (
        <Text style={styles.readOnly}>
          You can read this conversation but can't reply.
        </Text>
      ) : (
        <View style={styles.inputRow}>
          <TextInput
            ref={inputRef}
            value={text}
            onChangeText={handleChangeText}
            onSelectionChange={handleSelectionChange}
            placeholder={placeholder}
            placeholderTextColor={colors.text.placeholder}
            style={styles.input}
            multiline
            maxLength={MAX_MESSAGE_LENGTH}
            accessibilityLabel="Message"
            testID="composer-input"
          />
          {remaining !== null ? (
            <Text
              style={[styles.counter, remaining <= 0 && styles.counterLimit]}
              accessibilityLabel={`${remaining} characters left`}
              testID="composer-length-counter"
            >
              {remaining}
            </Text>
          ) : null}
          <Pressable
            onPress={() => void handleSend()}
            disabled={!canSend}
            style={({ pressed }) => [
              styles.send,
              !canSend && styles.sendDisabled,
              pressed && styles.sendPressed,
            ]}
            hitSlop={(touchTarget.min - SEND_BUTTON_SIZE) / 2}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !canSend }}
            testID="composer-send"
          >
            {isSubmitting ? (
              <ActivityIndicator size="small" color={ON_ACCENT} />
            ) : (
              <Ionicons name="arrow-up" size={20} color={ON_ACCENT} />
            )}
          </Pressable>
        </View>
      )}
    </View>
  );
});

const useStyles = () =>
  useThemedStyles(({ colors, glass }) => ({
    container: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: glass.borderColor,
      backgroundColor: colors.background.main,
      gap: spacing.sm,
    },
    attachment: {
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radii.md,
      backgroundColor: withAlpha(colors.purple, 0.12),
      borderLeftWidth: 3,
      borderLeftColor: colors.purple,
    },
    attachmentBody: { flex: 1 },
    attachmentTitle: {
      fontSize: typography.size.body2,
      fontWeight: typography.weight.semibold,
      color: colors.purple,
    },
    attachmentText: { fontSize: typography.size.body2, color: colors.text.body },
    inputRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
    input: {
      flex: 1,
      minHeight: 40,
      maxHeight: INPUT_MAX_HEIGHT,
      paddingHorizontal: spacing.lg,
      paddingTop: Platform.OS === "ios" ? 10 : 8,
      paddingBottom: Platform.OS === "ios" ? 10 : 8,
      borderRadius: radii.xl,
      backgroundColor: colors.background.surface,
      borderWidth: 1,
      borderColor: colors.background.border,
      color: colors.text.primary,
      fontSize: typography.size.md,
    },
    send: {
      width: SEND_BUTTON_SIZE,
      height: SEND_BUTTON_SIZE,
      borderRadius: SEND_BUTTON_SIZE / 2,
      marginBottom: 2,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.purple,
    },
    sendDisabled: { backgroundColor: colors.background.subtle },
    counter: {
      alignSelf: "flex-end",
      marginBottom: 10,
      fontSize: typography.size.sm,
      color: colors.text.secondary,
      fontVariant: ["tabular-nums"],
    },
    counterLimit: { color: colors.error },
    sendPressed: { transform: [{ scale: 0.92 }] },
    readOnly: {
      textAlign: "center",
      color: colors.text.secondary,
      fontSize: typography.size.body,
      paddingVertical: spacing.md,
    },
  }));
