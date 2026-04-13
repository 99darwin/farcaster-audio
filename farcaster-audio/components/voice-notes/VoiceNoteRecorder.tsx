import { useState, useCallback, useRef, useEffect } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  Switch,
  Modal,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Animated,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useVoiceNoteRecorder } from "@/hooks/useVoiceNoteRecorder";
import { useVoiceNoteStore } from "@/stores/voiceNoteStore";
import { useAuthStore } from "@/stores/authStore";
import * as voiceNotesApi from "@/services/voiceNotes";
import { Waveform } from "./Waveform";
import { colors, radii, typography } from "@/constants/theme";

type ModalState =
  | "pre-record"
  | "recording"
  | "review"
  | "compose"
  | "posting"
  | "posted";

const MAX_CAPTION_LENGTH = 1024;
const AUTO_DISMISS_MS = 1500;

interface VoiceNoteRecorderProps {
  isVisible: boolean;
  onClose: () => void;
}

function formatTimer(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function VoiceNoteRecorder({
  isVisible,
  onClose,
}: VoiceNoteRecorderProps) {
  const [modalState, setModalState] = useState<ModalState>("pre-record");
  const [caption, setCaption] = useState("");
  const [postToFarcaster, setPostToFarcaster] = useState(true);
  const [postError, setPostError] = useState<string | null>(null);

  const recorder = useVoiceNoteRecorder();
  const prependVoiceNote = useVoiceNoteStore((s) => s.prependVoiceNote);
  const user = useAuthStore((s) => s.user);

  const pulseAnim = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (modalState === "recording") {
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
  }, [modalState, pulseAnim]);

  const doClose = useCallback(() => {
    if (recorder.state === "recording") {
      recorder.cancelRecording();
    }
    recorder.reset();
    setModalState("pre-record");
    setCaption("");
    setPostToFarcaster(true);
    setPostError(null);
    onClose();
  }, [recorder, onClose]);

  const handleClose = useCallback(() => {
    if (
      recorder.state === "recording" ||
      modalState === "review" ||
      modalState === "compose"
    ) {
      Alert.alert("Discard recording?", "Your voice note will be lost.", [
        { text: "Cancel", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: doClose },
      ]);
      return;
    }
    doClose();
  }, [recorder.state, modalState, doClose]);

  const handleStartRecording = useCallback(async () => {
    await recorder.startRecording();
    setModalState("recording");
  }, [recorder]);

  const handleStopRecording = useCallback(async () => {
    await recorder.stopRecording();
    setModalState("review");
  }, [recorder]);

  const handleReRecord = useCallback(() => {
    Alert.alert("Re-record?", "Your current recording will be discarded.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Re-record",
        style: "destructive",
        onPress: () => {
          recorder.reset();
          setModalState("pre-record");
        },
      },
    ]);
  }, [recorder]);

  const handleNext = useCallback(() => {
    setModalState("compose");
  }, []);

  const handlePost = useCallback(async () => {
    if (!recorder.result || !user) return;

    setPostError(null);
    setModalState("posting");

    try {
      // 1. Get presigned upload URL
      const { upload_id, upload_url } = await voiceNotesApi.getUploadUrl(
        recorder.result.durationMs,
      );

      // 2. Upload audio file
      await voiceNotesApi.uploadAudioFile(upload_url, recorder.result.filePath);

      // 3. Finalize voice note
      const { voice_note } = await voiceNotesApi.createVoiceNote({
        upload_id,
        duration_ms: recorder.result.durationMs,
        audio_size: 0, // Server calculates from S3
        post_to_farcaster: postToFarcaster,
        cast_text: caption,
      });

      // 4. Prepend to local feed store
      prependVoiceNote({
        voice_note,
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

      // 5. Show success, then auto-dismiss
      setModalState("posted");
      setTimeout(doClose, AUTO_DISMISS_MS);
    } catch (err) {
      setPostError(
        err instanceof Error ? err.message : "Failed to post voice note",
      );
      setModalState("compose");
    }
  }, [
    recorder.result,
    user,
    caption,
    postToFarcaster,
    prependVoiceNote,
    doClose,
  ]);

  const renderContent = () => {
    switch (modalState) {
      case "pre-record":
        return (
          <View style={styles.centeredContent}>
            <Text style={styles.title}>Record a voice note</Text>
            <Text style={styles.subtitle}>Up to 60 seconds</Text>
            <Pressable
              onPress={handleStartRecording}
              style={styles.micButton}
              accessibilityLabel="Start recording"
              accessibilityRole="button"
            >
              <Ionicons name="mic" size={48} color={colors.text.primary} />
            </Pressable>
            <Text style={styles.hint}>Tap to start</Text>
          </View>
        );

      case "recording":
        return (
          <View style={styles.centeredContent}>
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
            <Text style={styles.hint}>Tap to stop</Text>
          </View>
        );

      case "review":
        return (
          <View style={styles.centeredContent}>
            <Text style={styles.title}>Review</Text>
            {recorder.result && (
              <>
                <Text style={styles.timer}>
                  {formatTimer(recorder.result.durationMs)}
                </Text>
                <View style={styles.reviewWaveformContainer}>
                  <Waveform
                    peaks={recorder.result.peaks}
                    progress={0}
                    height={64}
                  />
                </View>
              </>
            )}
            <View style={styles.reviewActions}>
              <Pressable
                onPress={handleReRecord}
                style={styles.secondaryButton}
                accessibilityLabel="Re-record"
                accessibilityRole="button"
              >
                <Ionicons
                  name="refresh"
                  size={20}
                  color={colors.text.secondary}
                />
                <Text style={styles.secondaryButtonText}>Re-record</Text>
              </Pressable>
              <Pressable
                onPress={handleNext}
                style={styles.primaryButton}
                accessibilityLabel="Next"
                accessibilityRole="button"
              >
                <Text style={styles.primaryButtonText}>Next</Text>
                <Ionicons
                  name="arrow-forward"
                  size={20}
                  color={colors.text.primary}
                />
              </Pressable>
            </View>
          </View>
        );

      case "compose":
        return (
          <KeyboardAvoidingView
            behavior={Platform.OS === "ios" ? "padding" : "height"}
            style={styles.composeContainer}
          >
            <Text style={styles.title}>Add details</Text>

            <TextInput
              style={styles.captionInput}
              placeholder="Add a caption (optional)"
              placeholderTextColor={colors.text.placeholder}
              value={caption}
              onChangeText={setCaption}
              maxLength={MAX_CAPTION_LENGTH}
              multiline
              textAlignVertical="top"
            />
            <Text style={styles.charCount}>
              {caption.length}/{MAX_CAPTION_LENGTH}
            </Text>

            <View style={styles.switchRow}>
              <View>
                <Text style={styles.switchLabel}>Post to Farcaster</Text>
                <Text style={styles.switchHint}>
                  Share as a cast with embedded audio
                </Text>
              </View>
              <Switch
                value={postToFarcaster}
                onValueChange={setPostToFarcaster}
                trackColor={{
                  false: colors.background.subtle,
                  true: colors.accent,
                }}
                thumbColor={colors.text.primary}
              />
            </View>

            {postError && <Text style={styles.errorText}>{postError}</Text>}

            <Pressable
              onPress={handlePost}
              style={styles.postButton}
              accessibilityLabel="Post voice note"
              accessibilityRole="button"
            >
              <Ionicons name="send" size={18} color={colors.text.primary} />
              <Text style={styles.postButtonText}>Post</Text>
            </Pressable>
          </KeyboardAvoidingView>
        );

      case "posting":
        return (
          <View style={styles.centeredContent}>
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.subtitle}>Posting your voice note...</Text>
          </View>
        );

      case "posted":
        return (
          <View style={styles.centeredContent}>
            <Ionicons
              name="checkmark-circle"
              size={64}
              color={colors.success}
            />
            <Text style={styles.title}>Posted!</Text>
          </View>
        );
    }
  };

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
    >
      <SafeAreaView style={styles.modal}>
        <View style={styles.header}>
          <Pressable
            onPress={handleClose}
            style={styles.closeButton}
            accessibilityLabel="Close"
            accessibilityRole="button"
          >
            <Ionicons name="close" size={24} color={colors.text.primary} />
          </Pressable>
        </View>
        {renderContent()}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: {
    flex: 1,
    backgroundColor: colors.background.main,
  },
  header: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  closeButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  centeredContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    gap: 16,
  },
  title: {
    color: colors.text.primary,
    fontSize: typography.size["2xl"],
    fontWeight: "700",
  },
  subtitle: {
    color: colors.text.secondary,
    fontSize: typography.size.md,
  },
  hint: {
    color: colors.text.placeholder,
    fontSize: typography.size.sm,
    marginTop: 8,
  },
  micButton: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 24,
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
    fontSize: typography.size.body,
    fontWeight: "600",
  },
  timer: {
    color: colors.text.primary,
    fontSize: typography.size["3xl"],
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
  reviewWaveformContainer: {
    width: "100%",
    marginVertical: 16,
  },
  reviewActions: {
    flexDirection: "row",
    gap: 16,
    marginTop: 24,
  },
  secondaryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: radii.md,
    backgroundColor: colors.background.surface,
    borderWidth: 1,
    borderColor: colors.background.border,
  },
  secondaryButtonText: {
    color: colors.text.secondary,
    fontSize: typography.size.body,
    fontWeight: "600",
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: radii.md,
    backgroundColor: colors.accent,
  },
  primaryButtonText: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    fontWeight: "600",
  },
  composeContainer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 16,
    gap: 12,
  },
  captionInput: {
    backgroundColor: colors.background.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.background.border,
    color: colors.text.primary,
    fontSize: typography.size.body,
    padding: 16,
    minHeight: 100,
    maxHeight: 200,
  },
  charCount: {
    color: colors.text.placeholder,
    fontSize: typography.size.sm,
    textAlign: "right",
  },
  switchRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
  },
  switchLabel: {
    color: colors.text.primary,
    fontSize: typography.size.body,
    fontWeight: "600",
  },
  switchHint: {
    color: colors.text.secondary,
    fontSize: typography.size.sm,
    marginTop: 2,
  },
  errorText: {
    color: colors.error,
    fontSize: typography.size.sm,
  },
  postButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.accent,
    borderRadius: radii.md,
    paddingVertical: 14,
    marginTop: 8,
  },
  postButtonText: {
    color: colors.text.primary,
    fontSize: typography.size.lg,
    fontWeight: "700",
  },
});
