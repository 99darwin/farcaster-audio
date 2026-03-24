import { useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { useAuthStore } from '@/stores/authStore';
import { Avatar } from '@/components/common/Avatar';
import { colors } from '@/constants/theme';
import type { NeynarCast } from '@/types/neynar';

const MAX_CAST_LENGTH = 320;

interface ComposeModalProps {
  isVisible: boolean;
  onClose: () => void;
  onPublish: (text: string, parentHash?: string) => Promise<void>;
  replyTo?: NeynarCast | null;
}

export function ComposeModal({ isVisible, onClose, onPublish, replyTo }: ComposeModalProps) {
  const user = useAuthStore((s) => s.user);
  const [text, setText] = useState('');
  const [isPublishing, setIsPublishing] = useState(false);

  const charCount = text.length;
  const isOverLimit = charCount > MAX_CAST_LENGTH;
  const canPublish = text.trim().length > 0 && !isOverLimit && !isPublishing;

  const handlePublish = async () => {
    if (!canPublish) return;
    setIsPublishing(true);
    try {
      await onPublish(text.trim(), replyTo?.hash);
      setText('');
      onClose();
    } catch (err) {
      console.error('[Compose] Failed to publish cast:', err);
      Toast.show({ type: 'error', text1: 'Error', text2: 'Failed to publish cast. Please try again.' });
    } finally {
      setIsPublishing(false);
    }
  };

  const handleClose = () => {
    if (isPublishing) return;
    setText('');
    onClose();
  };

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={handleClose} hitSlop={12} disabled={isPublishing}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handlePublish}
            style={[styles.publishButton, !canPublish && styles.publishButtonDisabled]}
            disabled={!canPublish}
          >
            {isPublishing ? (
              <ActivityIndicator size="small" color={colors.text.primary} />
            ) : (
              <Text style={[styles.publishText, !canPublish && styles.publishTextDisabled]}>
                {replyTo ? 'Reply' : 'Cast'}
              </Text>
            )}
          </Pressable>
        </View>

        {/* Reply context */}
        {replyTo && (
          <View style={styles.replyContext}>
            <Ionicons name="return-down-forward" size={14} color={colors.text.secondary} />
            <Text style={styles.replyText} numberOfLines={1}>
              Replying to @{replyTo.author.username}
            </Text>
          </View>
        )}

        {/* Compose area */}
        <View style={styles.composeArea}>
          <Avatar
            pfpUrl={user?.pfp_url ?? null}
            displayName={user?.display_name ?? ''}
            size="md"
          />
          <TextInput
            style={styles.input}
            placeholder={replyTo ? 'Post your reply' : "What's happening?"}
            placeholderTextColor={colors.text.placeholder}
            multiline
            autoFocus
            maxLength={MAX_CAST_LENGTH + 50}
            value={text}
            onChangeText={setText}
            editable={!isPublishing}
          />
        </View>

        {/* Character count */}
        <View style={styles.footer}>
          <Text style={[styles.charCount, isOverLimit && styles.charCountOver]}>
            {charCount}/{MAX_CAST_LENGTH}
          </Text>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
  },
  cancelText: {
    color: colors.text.secondary,
    fontSize: 16,
  },
  publishButton: {
    backgroundColor: colors.purple,
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 70,
    alignItems: 'center',
  },
  publishButtonDisabled: {
    opacity: 0.4,
  },
  publishText: {
    color: colors.text.primary,
    fontWeight: '700',
    fontSize: 15,
  },
  publishTextDisabled: {
    color: colors.text.light,
  },
  replyContext: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  replyText: {
    color: colors.text.secondary,
    fontSize: 14,
  },
  composeArea: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
    flex: 1,
  },
  input: {
    flex: 1,
    color: colors.text.body,
    fontSize: 17,
    lineHeight: 24,
    textAlignVertical: 'top',
    paddingTop: 0,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.background.border,
  },
  charCount: {
    color: colors.text.secondary,
    fontSize: 13,
  },
  charCountOver: {
    color: colors.error,
  },
});
