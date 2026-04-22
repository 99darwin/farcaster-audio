import { useState, useEffect, useRef, useCallback } from "react";
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
  Alert,
  Switch,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import Toast from "react-native-toast-message";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { uploadImage, uploadVideo } from "@/services/api";
import { useAuthStore } from "@/stores/authStore";
import { useVoiceNoteStore } from "@/stores/voiceNoteStore";
import { useVoiceNoteRecorder } from "@/hooks/useVoiceNoteRecorder";
import * as voiceNotesApi from "@/services/voiceNotes";
import { Avatar } from "@/components/common/Avatar";
import { MentionSuggestions } from "@/components/common/MentionSuggestions";
import { Waveform } from "@/components/voice-notes/Waveform";
import { useOgPreview, extractUrls } from "@/hooks/useOgPreview";
import { colors } from "@/constants/theme";
import type { NeynarCast } from "@/types/neynar";

const CAST_LENGTH_DEFAULT = 320;
const CAST_LENGTH_PRO = 10000;
const MAX_IMAGES_DEFAULT = 2;
const MAX_IMAGES_PRO = 4;

type RecordingState = "idle" | "recording" | "recorded";

function formatTimer(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

interface ComposeModalProps {
  isVisible: boolean;
  onClose: () => void;
  onPublish: (
    text: string,
    parentHash?: string,
    imageUris?: string[],
    quote?: { fid: number; hash: string },
  ) => Promise<void>;
  /**
   * Called after a voice reply successfully posts. Lets the parent screen
   * refresh its thread so the new voice reply appears under the parent cast.
   * Separate from onPublish because no text cast is published for voice replies.
   */
  onVoiceReplyPosted?: (parentHash: string) => void | Promise<void>;
  replyTo?: NeynarCast | null;
  quoteCast?: NeynarCast | null;
  defaultText?: string;
  defaultEmbeds?: string[];
}

export function ComposeModal({
  isVisible,
  onClose,
  onPublish,
  onVoiceReplyPosted,
  replyTo,
  quoteCast,
  defaultText,
  defaultEmbeds,
}: ComposeModalProps) {
  const user = useAuthStore((s) => s.user);
  const isPro = user?.is_pro ?? false;
  const maxCastLength = isPro ? CAST_LENGTH_PRO : CAST_LENGTH_DEFAULT;
  const maxImages = isPro ? MAX_IMAGES_PRO : MAX_IMAGES_DEFAULT;
  const [text, setText] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [attachments, setAttachments] = useState<
    Array<{ uri: string; type: "image" | "video" }>
  >([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const [postToFarcaster, setPostToFarcaster] = useState(true);
  const keyboardPadding = useRef(new Animated.Value(0)).current;

  // Voice recording state
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const recorder = useVoiceNoteRecorder();
  const prependVoiceNote = useVoiceNoteStore((s) => s.prependVoiceNote);

  // Preview playback for recorded voice note
  const previewSource =
    recordingState === "recorded" && recorder.result
      ? `file://${recorder.result.filePath}`
      : null;
  const previewPlayer = useAudioPlayer(previewSource);
  const previewStatus = useAudioPlayerStatus(previewPlayer);
  const isPreviewPlaying = previewStatus.playing;
  const previewProgress =
    recorder.result && recorder.result.durationMs > 0
      ? Math.round((previewStatus.currentTime ?? 0) * 1000) /
        recorder.result.durationMs
      : 0;

  const togglePreviewPlay = useCallback(() => {
    if (isPreviewPlaying) {
      previewPlayer.pause();
    } else {
      previewPlayer.play();
    }
  }, [isPreviewPlaying, previewPlayer]);

  // Pulse animation for recording indicator
  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (recordingState === "recording") {
      const animation = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.3,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ]),
      );
      animation.start();
      return () => animation.stop();
    }
  }, [recordingState, pulseAnim]);

  // OG preview for URLs detected in the text
  const { ogData, isLoading: ogLoading, dismissPreview } = useOgPreview(text);

  // Seed text from draft when modal opens with defaultText or embeds.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!isVisible) {
      seededRef.current = false;
      return;
    }
    if (seededRef.current) return;
    seededRef.current = true;
    const parts: string[] = [];
    if (defaultText) parts.push(defaultText);
    if (defaultEmbeds?.length) parts.push(...defaultEmbeds);
    if (parts.length > 0) {
      const initial = parts.join("\n");
      setText(initial);
      setCursorPosition(initial.length);
    }
  }, [isVisible, defaultText, defaultEmbeds]);

  const handleSelectionChange = useCallback(
    (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
      setCursorPosition(e.nativeEvent.selection.end);
    },
    [],
  );

  const handleMentionSelect = useCallback(
    (username: string, mentionStart: number) => {
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
    const showSub = Keyboard.addListener("keyboardWillShow", (e) => {
      Animated.timing(keyboardPadding, {
        toValue: e.endCoordinates.height,
        duration: e.duration,
        useNativeDriver: false,
      }).start();
    });
    const hideSub = Keyboard.addListener("keyboardWillHide", (e) => {
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

  const hasVideo = attachments.some((a) => a.type === "video");
  const hasVoiceNote = recordingState === "recorded" && !!recorder.result;
  const charCount = text.length;
  const isOverLimit = charCount > maxCastLength;
  const hasContent =
    text.trim().length > 0 ||
    attachments.length > 0 ||
    hasVoiceNote ||
    !!quoteCast;
  const canPublish =
    hasContent &&
    !isOverLimit &&
    !isPublishing &&
    recordingState !== "recording";

  // --- Voice recording handlers ---

  const handleStartRecording = useCallback(async () => {
    if (!recorder.isAvailable) {
      Toast.show({
        type: "error",
        text1: "Native rebuild required",
        text2:
          "Voice recording requires a native build with JukeVoiceRecorder.",
      });
      return;
    }
    Keyboard.dismiss();
    // Clear media attachments — voice note replaces images/video
    setAttachments([]);
    await recorder.startRecording();
    setRecordingState("recording");
  }, [recorder]);

  const handleStopRecording = useCallback(async () => {
    await recorder.stopRecording();
    setRecordingState("recorded");
  }, [recorder]);

  const handleRemoveVoiceNote = useCallback(() => {
    Alert.alert("Remove voice note?", "Your recording will be discarded.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          previewPlayer.pause();
          recorder.reset();
          setRecordingState("idle");
        },
      },
    ]);
  }, [recorder, previewPlayer]);

  // --- Media handlers ---

  const handlePickMedia = async () => {
    if (hasVideo || hasVoiceNote || attachments.length >= maxImages) return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.8,
      selectionLimit: hasVideo ? 0 : maxImages - attachments.length,
      allowsMultipleSelection: !hasVideo,
    });

    if (!result.canceled) {
      const newAttachments = result.assets.map((a) => ({
        uri: a.uri,
        type: (a.type === "video" ? "video" : "image") as "image" | "video",
      }));

      const hasNewVideo = newAttachments.some((a) => a.type === "video");
      if (hasNewVideo) {
        setAttachments([newAttachments.find((a) => a.type === "video")!]);
      } else {
        setAttachments((prev) =>
          [...prev, ...newAttachments].slice(0, maxImages),
        );
      }
    }
  };

  const handleRemoveAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  // --- Publish ---

  const handlePublish = async () => {
    if (!canPublish) return;
    setIsPublishing(true);
    try {
      if (hasVoiceNote && recorder.result && user) {
        // Voice note publish flow
        const { upload_id, upload_url } = await voiceNotesApi.getUploadUrl(
          recorder.result.durationMs,
        );
        await voiceNotesApi.uploadAudioFile(
          upload_url,
          recorder.result.filePath,
        );
        const voiceNote = await voiceNotesApi.createVoiceNote({
          upload_id,
          duration_ms: recorder.result.durationMs,
          audio_size: 0,
          post_to_farcaster: postToFarcaster,
          cast_text: text.trim(),
          parent_cast_hash: replyTo?.hash,
        });

        prependVoiceNote({
          voice_note: voiceNote,
          author: {
            fid: user.fid,
            username: user.username,
            display_name: user.display_name,
            pfp_url: user.pfp_url,
          },
          reaction_counts: {},
          viewer_reactions: [],
          play_count: 0,
        });

        if (replyTo?.hash && onVoiceReplyPosted) {
          try {
            await onVoiceReplyPosted(replyTo.hash);
          } catch {
            // Non-fatal: the voice note was already posted; refresh is best-effort.
          }
        }
      } else {
        // Normal cast publish flow
        let uploadedUrls: string[] | undefined;
        if (attachments.length > 0) {
          uploadedUrls = await Promise.all(
            attachments.map((a) =>
              a.type === "video" ? uploadVideo(a.uri) : uploadImage(a.uri),
            ),
          );
        }

        const textUrls = extractUrls(text.trim());
        const allEmbeds = [...(uploadedUrls ?? []), ...textUrls].slice(0, 4);

        const quote = quoteCast
          ? { fid: quoteCast.author.fid, hash: quoteCast.hash }
          : undefined;
        await onPublish(
          text.trim(),
          replyTo?.hash,
          allEmbeds.length > 0 ? allEmbeds : undefined,
          quote,
        );
      }

      resetState();
      onClose();
    } catch (err: any) {
      const detail =
        err?.response?.data?.detail || err?.message || "Unknown error";
      console.error("[Compose] Failed to publish:", detail, err);
      Toast.show({
        type: "error",
        text1: "Error",
        text2: `Failed to publish: ${detail}`,
      });
    } finally {
      setIsPublishing(false);
    }
  };

  const resetState = useCallback(() => {
    setText("");
    setAttachments([]);
    setRecordingState("idle");
    setPostToFarcaster(true);
    recorder.reset();
  }, [recorder]);

  const handleClose = () => {
    if (isPublishing) return;
    if (recordingState === "recording") {
      Alert.alert("Discard recording?", "Your voice note will be lost.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            recorder.cancelRecording();
            resetState();
            onClose();
          },
        },
      ]);
      return;
    }
    if (recordingState === "recorded") {
      Alert.alert("Discard draft?", "Your voice note and text will be lost.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            resetState();
            onClose();
          },
        },
      ]);
      return;
    }
    resetState();
    onClose();
  };

  const publishLabel = hasVoiceNote
    ? "Post"
    : replyTo
      ? "Reply"
      : quoteCast
        ? "Quote"
        : "Cast";

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <Animated.View
        style={[styles.container, { paddingBottom: keyboardPadding }]}
      >
        {/* Header */}
        <View style={styles.header}>
          <Pressable onPress={handleClose} hitSlop={12} disabled={isPublishing}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handlePublish}
            style={[
              styles.publishButton,
              !canPublish && styles.publishButtonDisabled,
            ]}
            disabled={!canPublish}
          >
            {isPublishing ? (
              <ActivityIndicator size="small" color={colors.text.primary} />
            ) : (
              <Text
                style={[
                  styles.publishText,
                  !canPublish && styles.publishTextDisabled,
                ]}
              >
                {publishLabel}
              </Text>
            )}
          </Pressable>
        </View>

        {/* Reply context */}
        {replyTo && (
          <View style={styles.replyContext}>
            <Ionicons
              name="return-down-forward"
              size={14}
              color={colors.text.secondary}
            />
            <Text style={styles.replyText} numberOfLines={1}>
              Replying to @{replyTo.author.username}
            </Text>
          </View>
        )}

        {/* Recording state: full-screen recording UI */}
        {recordingState === "recording" ? (
          <View style={styles.recordingOverlay}>
            <View style={styles.recordingIndicator}>
              <Animated.View
                style={[styles.recordingDot, { opacity: pulseAnim }]}
              />
              <Text style={styles.recordingLabel}>Recording</Text>
            </View>
            <Text style={styles.timer}>{formatTimer(recorder.elapsedMs)}</Text>
            <View style={styles.liveWaveformContainer}>
              <Waveform
                peaks={recorder.livePeaks}
                progress={1}
                height={64}
                filledColor={colors.accent}
              />
            </View>
            <Pressable
              onPress={handleStopRecording}
              style={styles.stopButton}
              accessibilityLabel="Stop recording"
              accessibilityRole="button"
            >
              <View style={styles.stopSquare} />
            </Pressable>
            <Text style={styles.recordingHint}>Tap to stop</Text>
          </View>
        ) : (
          <>
            {/* Compose area */}
            <View style={styles.composeArea}>
              <Avatar
                pfpUrl={user?.pfp_url ?? null}
                displayName={user?.display_name ?? ""}
                size="md"
              />
              <View style={styles.inputArea}>
                <TextInput
                  style={styles.input}
                  placeholder={
                    hasVoiceNote
                      ? "Add a caption (optional)"
                      : quoteCast
                        ? "Add a comment..."
                        : replyTo
                          ? "Post your reply"
                          : "What's happening?"
                  }
                  placeholderTextColor={colors.text.placeholder}
                  multiline
                  autoFocus={!hasVoiceNote}
                  maxLength={maxCastLength + 50}
                  value={text}
                  onChangeText={(t) => {
                    setText(t);
                    setCursorPosition(t.length);
                  }}
                  onSelectionChange={handleSelectionChange}
                  editable={!isPublishing}
                />

                {/* Voice note attachment preview */}
                {hasVoiceNote && recorder.result && (
                  <View style={styles.voiceNotePreview}>
                    <Pressable
                      onPress={togglePreviewPlay}
                      hitSlop={8}
                      accessibilityLabel={
                        isPreviewPlaying ? "Pause preview" : "Play preview"
                      }
                      accessibilityRole="button"
                      style={styles.voiceNotePlayButton}
                    >
                      <Ionicons
                        name={isPreviewPlaying ? "pause" : "play"}
                        size={20}
                        color={colors.text.primary}
                      />
                    </Pressable>
                    <View style={styles.voiceNoteWaveform}>
                      <Waveform
                        peaks={recorder.result.peaks}
                        progress={previewProgress}
                        height={32}
                      />
                    </View>
                    <Text style={styles.voiceNoteDuration}>
                      {formatTimer(recorder.result.durationMs)}
                    </Text>
                    <Pressable
                      onPress={handleRemoveVoiceNote}
                      hitSlop={8}
                      accessibilityLabel="Remove voice note"
                      accessibilityRole="button"
                    >
                      <Ionicons
                        name="close-circle"
                        size={20}
                        color={colors.text.secondary}
                      />
                    </Pressable>
                  </View>
                )}

                {/* Post to Farcaster toggle (voice notes only) */}
                {hasVoiceNote && (
                  <View style={styles.farcasterToggle}>
                    <Ionicons
                      name="globe-outline"
                      size={16}
                      color={colors.text.secondary}
                    />
                    <Text style={styles.farcasterToggleLabel}>
                      Post to Farcaster
                    </Text>
                    <Switch
                      value={postToFarcaster}
                      onValueChange={setPostToFarcaster}
                      trackColor={{
                        false: colors.background.subtle,
                        true: colors.accent,
                      }}
                      thumbColor={colors.text.primary}
                      style={styles.farcasterSwitch}
                    />
                  </View>
                )}

                {quoteCast && (
                  <View style={styles.quotePreview}>
                    <View style={styles.quotePreviewHeader}>
                      {quoteCast.author.pfp_url ? (
                        <Image
                          source={{ uri: quoteCast.author.pfp_url }}
                          style={styles.quotePreviewAvatar}
                          contentFit="cover"
                        />
                      ) : null}
                      <Text style={styles.quotePreviewName} numberOfLines={1}>
                        {quoteCast.author.display_name}
                      </Text>
                      <Text style={styles.quotePreviewUsername}>
                        @{quoteCast.author.username}
                      </Text>
                    </View>
                    <Text style={styles.quotePreviewText} numberOfLines={3}>
                      {quoteCast.text}
                    </Text>
                  </View>
                )}
                {attachments.length > 0 && (
                  <ScrollView
                    horizontal
                    style={styles.imagePreviews}
                    showsHorizontalScrollIndicator={false}
                  >
                    {attachments.map((attachment, i) => (
                      <View key={attachment.uri} style={styles.previewWrapper}>
                        <Image
                          source={{ uri: attachment.uri }}
                          style={styles.previewImage}
                          contentFit="cover"
                        />
                        {attachment.type === "video" && (
                          <View style={styles.videoOverlay}>
                            <Ionicons name="play" size={20} color="#fff" />
                          </View>
                        )}
                        <Pressable
                          style={styles.removeImageButton}
                          onPress={() => handleRemoveAttachment(i)}
                          hitSlop={8}
                        >
                          <Ionicons
                            name="close-circle"
                            size={20}
                            color="#fff"
                          />
                        </Pressable>
                      </View>
                    ))}
                  </ScrollView>
                )}
                {/* OG link preview */}
                {ogLoading && (
                  <View style={styles.ogPreviewLoading}>
                    <ActivityIndicator
                      size="small"
                      color={colors.text.secondary}
                    />
                  </View>
                )}
                {ogData && !ogLoading && (
                  <View style={styles.ogPreviewCard}>
                    <Pressable
                      style={styles.ogDismiss}
                      onPress={dismissPreview}
                      hitSlop={8}
                    >
                      <Ionicons
                        name="close-circle"
                        size={18}
                        color={colors.text.secondary}
                      />
                    </Pressable>
                    {ogData.image ? (
                      <Image
                        source={{ uri: ogData.image }}
                        style={styles.ogPreviewImage}
                        contentFit="cover"
                      />
                    ) : null}
                    <View style={styles.ogPreviewText}>
                      <Text style={styles.ogPreviewDomain} numberOfLines={1}>
                        {
                          ogData.url
                            .replace(/^https?:\/\/(www\.)?/, "")
                            .split("/")[0]
                        }
                      </Text>
                      {ogData.title ? (
                        <Text style={styles.ogPreviewTitle} numberOfLines={2}>
                          {ogData.title}
                        </Text>
                      ) : null}
                      {ogData.description ? (
                        <Text style={styles.ogPreviewDesc} numberOfLines={2}>
                          {ogData.description}
                        </Text>
                      ) : null}
                    </View>
                  </View>
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
                  disabled={
                    isPublishing ||
                    hasVideo ||
                    hasVoiceNote ||
                    attachments.length >= maxImages
                  }
                  hitSlop={8}
                  style={{
                    opacity:
                      hasVideo ||
                      hasVoiceNote ||
                      attachments.length >= maxImages
                        ? 0.4
                        : 1,
                  }}
                >
                  <Ionicons
                    name="image-outline"
                    size={24}
                    color={colors.purple}
                  />
                </Pressable>
                {attachments.length > 0 && (
                  <Text style={styles.imageHint}>
                    {hasVideo ? "Video" : `${attachments.length}/${maxImages}`}
                  </Text>
                )}

                {/* Mic button */}
                <Pressable
                  onPress={handleStartRecording}
                  disabled={isPublishing || hasVoiceNote}
                  hitSlop={8}
                  style={{ opacity: isPublishing || hasVoiceNote ? 0.4 : 1 }}
                  accessibilityLabel="Record voice note"
                  accessibilityRole="button"
                >
                  <Ionicons
                    name="mic-outline"
                    size={24}
                    color={colors.accent}
                  />
                </Pressable>
              </View>
              <Text
                style={[styles.charCount, isOverLimit && styles.charCountOver]}
              >
                {charCount}/{maxCastLength}
              </Text>
            </View>
          </>
        )}
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
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
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
    alignItems: "center",
  },
  publishButtonDisabled: {
    opacity: 0.4,
  },
  publishText: {
    color: colors.text.primary,
    fontWeight: "700",
    fontSize: 15,
  },
  publishTextDisabled: {
    color: colors.text.light,
  },
  replyContext: {
    flexDirection: "row",
    alignItems: "center",
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
    flexDirection: "row",
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
    textAlignVertical: "top",
    paddingTop: 0,
  },
  // Voice note preview (inline attachment)
  voiceNotePreview: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: colors.background.surface,
    borderRadius: 12,
    padding: 12,
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.background.border,
  },
  voiceNoteWaveform: {
    flex: 1,
    overflow: "hidden",
  },
  voiceNotePlayButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  voiceNoteDuration: {
    color: colors.text.secondary,
    fontSize: 13,
    fontVariant: ["tabular-nums"],
  },
  // Farcaster toggle for voice notes
  farcasterToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    marginTop: 12,
  },
  farcasterToggleLabel: {
    color: colors.text.secondary,
    fontSize: 14,
    flex: 1,
  },
  farcasterSwitch: {
    transform: [{ scale: 0.8 }],
  },
  // Recording overlay
  recordingOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 16,
  },
  recordingIndicator: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  recordingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: colors.live,
  },
  recordingLabel: {
    color: colors.live,
    fontSize: 16,
    fontWeight: "600",
  },
  timer: {
    color: colors.text.primary,
    fontSize: 32,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  liveWaveformContainer: {
    width: "100%",
    marginVertical: 16,
  },
  stopButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.background.subtle,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: colors.live,
  },
  stopSquare: {
    width: 24,
    height: 24,
    borderRadius: 4,
    backgroundColor: colors.live,
  },
  recordingHint: {
    color: colors.text.placeholder,
    fontSize: 14,
    marginTop: 8,
  },
  // Existing styles
  imagePreviews: {
    flexDirection: "row",
    marginTop: 12,
  },
  previewWrapper: {
    marginRight: 8,
    position: "relative",
  },
  previewImage: {
    width: 60,
    height: 60,
    borderRadius: 8,
  },
  videoOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.3)",
    borderRadius: 8,
  },
  removeImageButton: {
    position: "absolute",
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
    flexDirection: "row",
    alignItems: "center",
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
    fontWeight: "600",
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
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.background.border,
  },
  footerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
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
  ogPreviewLoading: {
    marginTop: 12,
    alignItems: "center",
    paddingVertical: 8,
  },
  ogPreviewCard: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: colors.background.border,
    borderRadius: 12,
    overflow: "hidden",
  },
  ogDismiss: {
    position: "absolute",
    top: 6,
    right: 6,
    zIndex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    borderRadius: 9,
  },
  ogPreviewImage: {
    width: "100%",
    aspectRatio: 1.91,
  },
  ogPreviewText: {
    padding: 10,
    gap: 2,
  },
  ogPreviewDomain: {
    color: colors.text.secondary,
    fontSize: 12,
  },
  ogPreviewTitle: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: "600",
  },
  ogPreviewDesc: {
    color: colors.text.secondary,
    fontSize: 13,
    lineHeight: 18,
  },
});
