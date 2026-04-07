import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Keyboard,
  Animated,
  ActivityIndicator,
  ScrollView,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import Toast from 'react-native-toast-message';
import { uploadImage, uploadVideo } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { Avatar } from '@/components/common/Avatar';
import { MentionSuggestions } from '@/components/common/MentionSuggestions';
import { colors } from '@/constants/theme';
import type { NeynarCast } from '@/types/neynar';

const CAST_LENGTH_DEFAULT = 320;
const CAST_LENGTH_PRO = 10000;
const MAX_IMAGES_DEFAULT = 2;
const MAX_IMAGES_PRO = 4;

interface ComposeModalProps {
  isVisible: boolean;
  onClose: () => void;
  onPublish: (text: string, parentHash?: string, imageUris?: string[], quote?: { fid: number; hash: string }) => Promise<void>;
  replyTo?: NeynarCast | null;
  quoteCast?: NeynarCast | null;
}

export function ComposeModal({ isVisible, onClose, onPublish, replyTo, quoteCast }: ComposeModalProps) {
  const user = useAuthStore((s) => s.user);
  const isPro = user?.is_pro ?? false;
  const maxCastLength = isPro ? CAST_LENGTH_PRO : CAST_LENGTH_DEFAULT;
  // Farcaster protocol allows max 2 embeds per cast; quote counts as one slot
  const baseMaxImages = isPro ? MAX_IMAGES_PRO : MAX_IMAGES_DEFAULT;
  const maxImages = Math.max(0, baseMaxImages - (quoteCast ? 1 : 0));
  const [text, setText] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [attachments, setAttachments] = useState<Array<{ uri: string; type: 'image' | 'video' }>>([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const keyboardPadding = useRef(new Animated.Value(0)).current;

  const handleSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      setCursorPosition(e.nativeEvent.selection.end);
    },
    [],
  );

  const handleMentionSelect = useCallback(
    (username: string, mentionStart: number) => {
      // Replace @partial with @username and add a trailing space
      const before = text.slice(0, mentionStart);
      const after = text.slice(cursorPosition);
      const inserted = `@${username} `;
      const newText = before + inserted + after;
      setText(newText);
      setCursorPosition(before.length + inserted.length);
    },
    [text, cursorPosition],
  );

  useEffect(() => {
    const showSub = Keyboard.addListener('keyboardWillShow', (e) => {
      Animated.timing(keyboardPadding, {
        toValue: e.endCoordinates.height,
        duration: e.duration,
        useNativeDriver: false,
      }).start();
    });
    const hideSub = Keyboard.addListener('keyboardWillHide', (e) => {
      Animated.timing(keyboardPadding, {
        toValue: 0,
        duration: e.duration,
        useNativeDriver: false,
      }).start();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [keyboardPadding]);

  const hasVideo = attachments.some((a) => a.type === 'video');
  const charCount = text.length;
  const isOverLimit = charCount > maxCastLength;
  const hasContent = text.trim().length > 0 || attachments.length > 0 || !!quoteCast;
  const canPublish = hasContent && !isOverLimit && !isPublishing;

  const handlePickMedia = async () => {
    if (hasVideo || attachments.length >= maxImages) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.8,
      selectionLimit: hasVideo ? 0 : maxImages - attachments.length,
      allowsMultipleSelection: !hasVideo,
    });

    if (!result.canceled) {
      const newAttachments = result.assets.map((a) => ({
        uri: a.uri,
        type: (a.type === 'video' ? 'video' : 'image') as 'image' | 'video',
      }));

      // If a video is selected, only allow that one video
      const hasNewVideo = newAttachments.some((a) => a.type === 'video');
      if (hasNewVideo) {
        setAttachments([newAttachments.find((a) => a.type === 'video')!]);
      } else {
        setAttachments((prev) => [...prev, ...newAttachments].slice(0, maxImages));
      }
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const handlePublish = async () => {
    if (!canPublish) return;
    setIsPublishing(true);
    try {
      // Upload attachments to backend first, then pass hosted URLs as embeds
      let uploadedUrls: string[] | undefined;
      if (attachments.length > 0) {
        uploadedUrls = await Promise.all(
          attachments.map((a) => (a.type === 'video' ? uploadVideo(a.uri) : uploadImage(a.uri))),
        );
      }

      const quote = quoteCast
        ? { fid: quoteCast.author.fid, hash: quoteCast.hash }
        : undefined;
      await onPublish(text.trim(), replyTo?.hash, uploadedUrls, quote);
      setText('');
      setAttachments([]);
      onClose();
    } catch (err: any) {
      const detail = err?.response?.data?.detail || err?.message || 'Unknown error';
      console.error('[Compose] Failed to publish cast:', detail, err);
      Toast.show({ type: 'error', text1: 'Error', text2: `Failed to publish cast: ${detail}` });
    } finally {
      setIsPublishing(false);
    }
  };

  const handleClose = () => {
    if (isPublishing) return;
    setText('');
    setAttachments([]);
    onClose();
  };

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <Animated.View style={[styles.container, { paddingBottom: keyboardPadding }]}>
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
                {replyTo ? 'Reply' : quoteCast ? 'Quote' : 'Cast'}
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
              placeholder={quoteCast ? 'Add a comment...' : replyTo ? 'Post your reply' : "What's happening?"}
              placeholderTextColor={colors.text.placeholder}
              multiline
              autoFocus
              maxLength={maxCastLength + 50}
              value={text}
              onChangeText={(t) => { setText(t); setCursorPosition(t.length); }}
              onSelectionChange={handleSelectionChange}
              editable={!isPublishing}
            />
            {quoteCast && (
              <View style={styles.quotePreview}>
                <View style={styles.quotePreviewHeader}>
                  {quoteCast.author.pfp_url ? (
                    <Image source={{ uri: quoteCast.author.pfp_url }} style={styles.quotePreviewAvatar} contentFit="cover" />
                  ) : null}
                  <Text style={styles.quotePreviewName} numberOfLines={1}>{quoteCast.author.display_name}</Text>
                  <Text style={styles.quotePreviewUsername}>@{quoteCast.author.username}</Text>
                </View>
                <Text style={styles.quotePreviewText} numberOfLines={3}>{quoteCast.text}</Text>
              </View>
            )}
            {attachments.length > 0 && (
              <ScrollView horizontal style={styles.imagePreviews} showsHorizontalScrollIndicator={false}>
                {attachments.map((attachment, i) => (
                  <View key={attachment.uri} style={styles.previewWrapper}>
                    <Image source={{ uri: attachment.uri }} style={styles.previewImage} contentFit="cover" />
                    {attachment.type === 'video' && (
                      <View style={styles.videoOverlay}>
                        <Ionicons name="play" size={20} color="#fff" />
                      </View>
                    )}
                    <Pressable
                      style={styles.removeImageButton}
                      onPress={() => handleRemoveAttachment(i)}
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

        <MentionSuggestions
          text={text}
          cursorPosition={cursorPosition}
          onSelect={handleMentionSelect}
        />

        {/* Footer */}
        <View style={styles.footer}>
          <View style={styles.footerLeft}>
            <Pressable
              onPress={handlePickMedia}
              disabled={isPublishing || hasVideo || attachments.length >= maxImages}
              hitSlop={8}
              style={{ opacity: hasVideo || attachments.length >= maxImages ? 0.4 : 1 }}
            >
              <Ionicons name="image-outline" size={24} color={colors.purple} />
            </Pressable>
            {attachments.length > 0 && (
              <Text style={styles.imageHint}>
                {hasVideo ? 'Video' : `${attachments.length}/${maxImages}`}
              </Text>
            )}
          </View>
          <Text style={[styles.charCount, isOverLimit && styles.charCountOver]}>
            {charCount}/{maxCastLength}
          </Text>
        </View>
      </Animated.View>
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
  videoOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 8,
  },
  removeImageButton: {
    position: 'absolute',
    top: -6,
    right: -6,
  },
  quotePreview: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.background.border,
    borderRadius: 12,
    padding: 12,
  },
  quotePreviewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  quotePreviewAvatar: {
    width: 16,
    height: 16,
    borderRadius: 8,
  },
  quotePreviewName: {
    color: colors.text.primary,
    fontWeight: '600',
    fontSize: 13,
    flexShrink: 1,
  },
  quotePreviewUsername: {
    color: colors.text.secondary,
    fontSize: 13,
  },
  quotePreviewText: {
    color: colors.text.body,
    fontSize: 14,
    lineHeight: 19,
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
  footerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  imageHint: {
    color: colors.text.secondary,
    fontSize: 13,
  },
  charCount: {
    color: colors.text.secondary,
    fontSize: 13,
  },
  charCountOver: {
    color: colors.error,
  },
});
