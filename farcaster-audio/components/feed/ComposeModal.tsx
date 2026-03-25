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
  ScrollView,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import Toast from 'react-native-toast-message';
import { useAuthStore } from '@/stores/authStore';
import { Avatar } from '@/components/common/Avatar';
import { colors } from '@/constants/theme';
import type { NeynarCast } from '@/types/neynar';

const MAX_CAST_LENGTH = 320;
const MAX_IMAGES = 2;

interface ComposeModalProps {
  isVisible: boolean;
  onClose: () => void;
  onPublish: (text: string, parentHash?: string, imageUris?: string[]) => Promise<void>;
  replyTo?: NeynarCast | null;
}

export function ComposeModal({ isVisible, onClose, onPublish, replyTo }: ComposeModalProps) {
  const user = useAuthStore((s) => s.user);
  const [text, setText] = useState('');
  const [images, setImages] = useState<string[]>([]);
  const [isPublishing, setIsPublishing] = useState(false);

  const charCount = text.length;
  const isOverLimit = charCount > MAX_CAST_LENGTH;
  const hasContent = text.trim().length > 0 || images.length > 0;
  const canPublish = hasContent && !isOverLimit && !isPublishing;

  const handlePickImage = async () => {
    if (images.length >= MAX_IMAGES) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
      selectionLimit: MAX_IMAGES - images.length,
      allowsMultipleSelection: true,
    });

    if (!result.canceled) {
      const uris = result.assets.map((a) => a.uri);
      setImages((prev) => [...prev, ...uris].slice(0, MAX_IMAGES));
    }
  };

  const handleRemoveImage = (index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePublish = async () => {
    if (!canPublish) return;
    setIsPublishing(true);
    try {
      await onPublish(text.trim(), replyTo?.hash, images.length > 0 ? images : undefined);
      setText('');
      setImages([]);
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
    setImages([]);
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
          <View style={styles.inputArea}>
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
            {images.length > 0 && (
              <ScrollView horizontal style={styles.imagePreviews} showsHorizontalScrollIndicator={false}>
                {images.map((uri, i) => (
                  <View key={uri} style={styles.previewWrapper}>
                    <Image source={{ uri }} style={styles.previewImage} contentFit="cover" />
                    <Pressable
                      style={styles.removeImageButton}
                      onPress={() => handleRemoveImage(i)}
                      hitSlop={8}
                    >
                      <Ionicons name="close-circle" size={20} color="#fff" />
                    </Pressable>
                  </View>
                ))}
              </ScrollView>
            )}
          </View>
        </View>

        {/* Footer */}
        <View style={styles.footer}>
          <Pressable
            onPress={handlePickImage}
            disabled={isPublishing || images.length >= MAX_IMAGES}
            hitSlop={8}
            style={{ opacity: images.length >= MAX_IMAGES ? 0.4 : 1 }}
          >
            <Ionicons name="image-outline" size={24} color={colors.purple} />
          </Pressable>
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
  inputArea: {
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
  imagePreviews: {
    flexDirection: 'row',
    marginTop: 12,
  },
  previewWrapper: {
    marginRight: 8,
    position: 'relative',
  },
  previewImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
  },
  removeImageButton: {
    position: 'absolute',
    top: -6,
    right: -6,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
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
