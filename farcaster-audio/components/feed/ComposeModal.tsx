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
import { publishCastToChannel, uploadImage, uploadVideo } from "@/services/api";
import * as draftsApi from "@/services/drafts";
import { useAuthStore } from "@/stores/authStore";
import { useVoiceNoteStore } from "@/stores/voiceNoteStore";
import { useVoiceNoteRecorder } from "@/hooks/useVoiceNoteRecorder";
import * as voiceNotesApi from "@/services/voiceNotes";
import { Avatar } from "@/components/common/Avatar";
import { MentionSuggestions } from "@/components/common/MentionSuggestions";
import { ChannelSuggestions } from "@/components/feed/ChannelSuggestions";
import { GifPicker } from "@/components/feed/GifPicker";
import { Waveform } from "@/components/voice-notes/Waveform";
import { useOgPreview, extractUrls } from "@/hooks/useOgPreview";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { haptic } from "@/utils/haptics";
import type {
  ComposeDraft,
  ComposeDraftPayload,
  DraftCastSnapshot,
  DraftMediaEmbed,
  DraftQuoteCast,
  DraftVoiceMetadata,
} from "@/types/draft";
import type { GiphyGif } from "@/services/giphy";
import type { NeynarCast } from "@/types/neynar";

const CAST_LENGTH_DEFAULT = 320;
const CAST_LENGTH_PRO = 10000;
const MAX_IMAGES_DEFAULT = 2;
const MAX_IMAGES_PRO = 4;
const CHANNEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

type RecordingState = "idle" | "recording" | "recorded";
type ComposeAttachment = {
  uri: string;
  type: "image" | "video";
  source?: "giphy" | "local" | "uploaded";
};

function formatTimer(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function normalizeChannelInput(input: string): string {
  return input.trim().replace(/^\/+/, "");
}

function formatDraftTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

interface ComposeModalProps {
  isVisible: boolean;
  onClose: () => void;
  onPublish: (
    text: string,
    parentHash?: string,
    imageUris?: string[],
    quote?: { fid: number; hash: string },
    channelId?: string,
  ) => Promise<{ hash: string } | void>;
  onPublishComplete?: () => void | Promise<void>;
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
  initialChannelId?: string;
}

export function ComposeModal({
  isVisible,
  onClose,
  onPublish,
  onPublishComplete,
  onVoiceReplyPosted,
  replyTo,
  quoteCast,
  defaultText,
  defaultEmbeds,
  initialChannelId,
}: ComposeModalProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const user = useAuthStore((s) => s.user);
  const isPro = user?.is_pro ?? false;
  const maxCastLength = isPro ? CAST_LENGTH_PRO : CAST_LENGTH_DEFAULT;
  const maxImages = isPro ? MAX_IMAGES_PRO : MAX_IMAGES_DEFAULT;
  const [text, setText] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [drafts, setDrafts] = useState<ComposeDraft[]>([]);
  const [isLoadingDrafts, setIsLoadingDrafts] = useState(false);
  const [isDraftPickerOpen, setIsDraftPickerOpen] = useState(false);
  const [activeDraft, setActiveDraft] = useState<ComposeDraft | null>(null);
  const [draftParentCast, setDraftParentCast] =
    useState<DraftCastSnapshot | null>(null);
  const [draftQuoteCast, setDraftQuoteCast] =
    useState<DraftQuoteCast | null>(null);
  const [restoredVoice, setRestoredVoice] =
    useState<DraftVoiceMetadata | null>(null);
  const [postToFarcaster, setPostToFarcaster] = useState(true);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    null,
  );
  const inputRef = useRef<TextInput>(null);
  const channelSelectorTokenStartRef = useRef<number | null>(null);
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
  const hasRecordedVoiceNote =
    recordingState === "recorded" && !!recorder.result;
  const hasVoiceNote = hasRecordedVoiceNote || !!restoredVoice;
  const activeParentHash = replyTo?.hash ?? draftParentCast?.hash;
  const canSelectChannel =
    !activeParentHash && (!hasVoiceNote || postToFarcaster);
  const effectiveChannelId = canSelectChannel ? selectedChannelId : null;
  const charCount = text.length;
  const isOverLimit = charCount > maxCastLength;
  const hasContent =
    text.trim().length > 0 ||
    attachments.length > 0 ||
    hasVoiceNote ||
    !!quoteCast ||
    !!draftQuoteCast;
  const canPublish =
    hasContent &&
    !isOverLimit &&
    !isPublishing &&
    !isSavingDraft &&
    recordingState !== "recording";

  const placeCursor = useCallback((position: number) => {
    setCursorPosition(position);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setNativeProps({
        selection: { start: position, end: position },
      });
    });
  }, []);

  const handleChannelPillPress = useCallback(() => {
    if (!canSelectChannel || isPublishing) return;
    haptic.selection();
    const before = text.slice(0, cursorPosition);
    const after = text.slice(cursorPosition);
    const prefix = before.length === 0 || /\s$/.test(before) ? "" : " ";
    const inserted = `${prefix}/`;
    const nextText = before + inserted + after;
    const nextCursor = before.length + inserted.length;
    channelSelectorTokenStartRef.current = before.length + prefix.length;
    setText(nextText);
    placeCursor(nextCursor);
  }, [canSelectChannel, cursorPosition, isPublishing, placeCursor, text]);

  const handleChannelSelect = useCallback(
    (channelId: string, tokenStart: number) => {
      const after = text.slice(cursorPosition);
      const before = text.slice(0, tokenStart);
      const isSelectorToken = channelSelectorTokenStartRef.current === tokenStart;
      setSelectedChannelId(channelId);
      channelSelectorTokenStartRef.current = null;

      if (isSelectorToken) {
        setText(`${before}${after}`);
        placeCursor(tokenStart);
      } else {
        const inserted = `/${channelId} `;
        setText(`${before}${inserted}${after}`);
        placeCursor(before.length + inserted.length);
      }
      haptic.selection();
    },
    [cursorPosition, placeCursor, text],
  );

  useEffect(() => {
    if (!isVisible) return;
    if (replyTo || draftParentCast) {
      setSelectedChannelId(null);
      channelSelectorTokenStartRef.current = null;
      return;
    }
    const normalized = initialChannelId
      ? normalizeChannelInput(initialChannelId)
      : "";
    setSelectedChannelId(
      normalized && CHANNEL_ID_PATTERN.test(normalized) ? normalized : null,
    );
  }, [draftParentCast, initialChannelId, isVisible, replyTo]);

  useEffect(() => {
    if (activeParentHash || (hasVoiceNote && !postToFarcaster)) {
      setSelectedChannelId(null);
      channelSelectorTokenStartRef.current = null;
    }
  }, [activeParentHash, hasVoiceNote, postToFarcaster]);

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
    haptic.medium();
    Keyboard.dismiss();
    // Clear media attachments — voice note replaces images/video
    setAttachments([]);
    setRestoredVoice(null);
    await recorder.startRecording();
    setRecordingState("recording");
  }, [recorder]);

  const handleStopRecording = useCallback(async () => {
    haptic.light();
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
          setRestoredVoice(null);
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
        source: "local" as const,
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

  const handleSelectGif = useCallback(
    (gif: GiphyGif) => {
      setAttachments((prev) =>
        [
          ...prev,
          {
            uri: gif.gifUrl,
            type: "image" as const,
            source: "giphy" as const,
          },
        ].slice(0, maxImages),
      );
    },
    [maxImages],
  );

  const castToDraftSnapshot = useCallback(
    (cast: NeynarCast): DraftCastSnapshot => ({
      hash: cast.hash,
      text: cast.text,
      author: {
        fid: cast.author.fid,
        username: cast.author.username,
        display_name: cast.author.display_name,
        pfp_url: cast.author.pfp_url,
      },
    }),
    [],
  );

  const quoteToDraftSnapshot = useCallback(
    (cast: NeynarCast): DraftQuoteCast => ({
      fid: cast.author.fid,
      hash: cast.hash,
      text: cast.text,
      author: {
        fid: cast.author.fid,
        username: cast.author.username,
        display_name: cast.author.display_name,
        pfp_url: cast.author.pfp_url,
      },
    }),
    [],
  );

  const uploadDraftMedia = useCallback(async (): Promise<DraftMediaEmbed[]> => {
    const uploaded = await Promise.all(
      attachments.map(async (attachment) => {
        if (attachment.source === "giphy") {
          return {
            url: attachment.uri,
            type: "gif" as const,
            source: "giphy" as const,
          };
        }
        if (attachment.source === "uploaded") {
          return {
            url: attachment.uri,
            type: attachment.type,
            source: "uploaded" as const,
          };
        }
        const url =
          attachment.type === "video"
            ? await uploadVideo(attachment.uri)
            : await uploadImage(attachment.uri);
        return {
          url,
          type: attachment.type,
          source: "uploaded" as const,
        };
      }),
    );
    return uploaded;
  }, [attachments]);

  const buildDraftPayload = useCallback(
    async (): Promise<ComposeDraftPayload> => {
      const mediaEmbeds = hasRecordedVoiceNote ? [] : await uploadDraftMedia();
      const parentCast = replyTo
        ? castToDraftSnapshot(replyTo)
        : draftParentCast;
      const quote = quoteCast
        ? quoteToDraftSnapshot(quoteCast)
        : draftQuoteCast;
      const voiceMetadata = hasRecordedVoiceNote
        ? {
            duration_ms: recorder.result!.durationMs,
            audio_size: 0,
            content_type: "audio/mp4" as const,
            waveform_peaks: recorder.result!.peaks,
          }
        : activeDraft && restoredVoice
          ? undefined
          : restoredVoice;
      return {
        text,
        channel_id: effectiveChannelId,
        parent_cast_hash: parentCast?.hash ?? null,
        parent_cast: parentCast,
        quote_cast: quote,
        media_embeds: mediaEmbeds,
        ...(voiceMetadata !== undefined
          ? { voice_metadata: voiceMetadata }
          : {}),
        post_to_farcaster: postToFarcaster,
      };
    },
    [
      activeDraft,
      castToDraftSnapshot,
      draftParentCast,
      draftQuoteCast,
      effectiveChannelId,
      hasRecordedVoiceNote,
      postToFarcaster,
      quoteCast,
      quoteToDraftSnapshot,
      recorder.result,
      replyTo,
      restoredVoice,
      text,
      uploadDraftMedia,
    ],
  );

  const saveCurrentDraft = useCallback(async (): Promise<ComposeDraft> => {
    const payload = await buildDraftPayload();
    const saved = activeDraft
      ? await draftsApi.updateDraft(activeDraft.id, payload)
      : await draftsApi.createDraft(payload);
    if (hasRecordedVoiceNote && recorder.result) {
      const voiceUpload = await draftsApi.getDraftVoiceUploadUrl(saved.id, {
        duration_ms: recorder.result.durationMs,
        content_type: "audio/mp4",
        waveform_peaks: recorder.result.peaks,
      });
      await draftsApi.uploadDraftAudioFile(
        voiceUpload.upload_url,
        recorder.result.filePath,
      );
      return {
        ...saved,
        voice_metadata: voiceUpload.voice_metadata,
      };
    }
    return saved;
  }, [activeDraft, buildDraftPayload, hasRecordedVoiceNote, recorder.result]);

  const refreshDrafts = useCallback(async () => {
    setIsLoadingDrafts(true);
    try {
      setDrafts(await draftsApi.listDrafts());
    } catch (err: any) {
      Toast.show({
        type: "error",
        text1: "Could not load drafts",
        text2: err?.message ?? "Try again in a moment.",
      });
    } finally {
      setIsLoadingDrafts(false);
    }
  }, []);

  const openDraftPicker = useCallback(() => {
    haptic.selection();
    setIsDraftPickerOpen(true);
    refreshDrafts();
  }, [refreshDrafts]);

  const restoreDraft = useCallback((draft: ComposeDraft) => {
    haptic.selection();
    setActiveDraft(draft);
    setDraftParentCast(draft.parent_cast ?? null);
    setDraftQuoteCast(draft.quote_cast ?? null);
    setRestoredVoice(draft.voice_metadata ?? null);
    setText(draft.text);
    setCursorPosition(draft.text.length);
    setSelectedChannelId(draft.channel_id ?? null);
    setPostToFarcaster(draft.post_to_farcaster);
    setRecordingState("idle");
    recorder.reset();
    setAttachments(
      draft.media_embeds.map((embed) => ({
        uri: embed.preview_url ?? embed.url,
        type: embed.type === "video" ? "video" : "image",
        source: embed.source === "giphy" ? "giphy" : "uploaded",
      })),
    );
    setIsDraftPickerOpen(false);
  }, [recorder]);

  const handleDeleteDraft = useCallback(
    (draft: ComposeDraft) => {
      Alert.alert("Delete draft?", "This saved draft will be removed.", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await draftsApi.deleteDraft(draft.id);
              setDrafts((prev) => prev.filter((d) => d.id !== draft.id));
              if (activeDraft?.id === draft.id) setActiveDraft(null);
            } catch (err: any) {
              Toast.show({
                type: "error",
                text1: "Could not delete draft",
                text2: err?.message ?? "Try again in a moment.",
              });
            }
          },
        },
      ]);
    },
    [activeDraft?.id],
  );

  // --- Publish ---

  const handlePublish = async () => {
    if (!canPublish) return;
    haptic.light();
    setIsPublishing(true);
    try {
      if (activeDraft) {
        const saved = await saveCurrentDraft();
        const result = await draftsApi.publishDraft(saved.id);
        const hash =
          result?.cast?.hash ?? result?.hash ?? result?.voice_note?.cast_hash;
        if (hash) {
          Toast.show({
            type: "viewCast",
            props: { hash, parentHash: saved.parent_cast_hash ?? undefined },
            visibilityTime: 5000,
            position: "bottom",
          });
        }
        haptic.success();
        await onPublishComplete?.();
        resetState();
        onClose();
        return;
      }
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
          parent_cast_hash: activeParentHash,
          channel_id:
            postToFarcaster && !activeParentHash && effectiveChannelId
              ? effectiveChannelId
              : undefined,
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

        if (activeParentHash && onVoiceReplyPosted) {
          try {
            await onVoiceReplyPosted(activeParentHash);
          } catch {
            // Non-fatal: the voice note was already posted; refresh is best-effort.
          }
        }
      } else {
        // Normal cast publish flow
        let uploadedUrls: string[] | undefined;
        if (attachments.length > 0) {
          uploadedUrls = await Promise.all(
            attachments.map((a) => {
              if (a.source === "giphy") return Promise.resolve(a.uri);
              return a.type === "video"
                ? uploadVideo(a.uri)
                : uploadImage(a.uri);
            }),
          );
        }

        const textUrls = extractUrls(text.trim());
        const allEmbeds = [...(uploadedUrls ?? []), ...textUrls].slice(0, 4);

        const quote = quoteCast
          ? { fid: quoteCast.author.fid, hash: quoteCast.hash }
          : undefined;
        const result = effectiveChannelId
          ? await publishCastToChannel({
              text: text.trim(),
              embeds: allEmbeds.length > 0 ? allEmbeds : undefined,
              quote,
              channel_id: effectiveChannelId,
            })
          : await onPublish(
              text.trim(),
              activeParentHash,
              allEmbeds.length > 0 ? allEmbeds : undefined,
              quote,
              effectiveChannelId ?? undefined,
            );
        if (result?.hash) {
          Toast.show({
            type: "viewCast",
            props: { hash: result.hash, parentHash: activeParentHash },
            visibilityTime: 5000,
            position: "bottom",
          });
        }
      }

      haptic.success();
      await onPublishComplete?.();
      resetState();
      onClose();
    } catch (err: any) {
      const detail =
        err?.response?.data?.detail || err?.message || "Unknown error";
      console.error("[Compose] Failed to publish:", detail, err);
      haptic.error();
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
    setSelectedChannelId(null);
    setActiveDraft(null);
    setDraftParentCast(null);
    setDraftQuoteCast(null);
    setRestoredVoice(null);
    setIsDraftPickerOpen(false);
    channelSelectorTokenStartRef.current = null;
    recorder.reset();
  }, [recorder]);

  const saveAndClose = useCallback(async () => {
    if (!hasContent || isSavingDraft) return;
    setIsSavingDraft(true);
    try {
      await saveCurrentDraft();
      haptic.success();
      Toast.show({
        type: "success",
        text1: "Draft saved",
      });
      resetState();
      onClose();
    } catch (err: any) {
      haptic.error();
      Toast.show({
        type: "error",
        text1: "Could not save draft",
        text2: err?.response?.data?.detail || err?.message || "Try again.",
      });
    } finally {
      setIsSavingDraft(false);
    }
  }, [hasContent, isSavingDraft, onClose, resetState, saveCurrentDraft]);

  const handleClose = () => {
    if (isPublishing || isSavingDraft) return;
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
    if (hasContent) {
      Alert.alert("Save draft?", "Keep this compose draft for later.", [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Save draft",
          onPress: () => {
            saveAndClose();
          },
        },
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
    : activeParentHash
      ? "Reply"
      : quoteCast || draftQuoteCast
        ? "Quote"
        : "Cast";
  const visibleQuoteCast = quoteCast
    ? {
        author: quoteCast.author,
        text: quoteCast.text,
      }
    : draftQuoteCast?.author
      ? {
          author: draftQuoteCast.author,
          text: draftQuoteCast.text,
        }
      : null;

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
          <View style={styles.headerLeft}>
            <Pressable
              onPress={handleClose}
              hitSlop={12}
              disabled={isPublishing || isSavingDraft}
              accessibilityRole="button"
              accessibilityLabel="Cancel composing"
              accessibilityState={{ disabled: isPublishing || isSavingDraft }}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={openDraftPicker}
              hitSlop={12}
              disabled={isPublishing || isSavingDraft}
              accessibilityRole="button"
              accessibilityLabel="Open drafts"
            >
              <Text style={styles.draftsText}>Drafts</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={handlePublish}
            style={[
              styles.publishButton,
              !canPublish && styles.publishButtonDisabled,
            ]}
            disabled={!canPublish}
            accessibilityRole="button"
            accessibilityLabel={publishLabel}
            accessibilityState={{
              disabled: !canPublish,
              busy: isPublishing,
            }}
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
        {(replyTo || draftParentCast) && (
          <View style={styles.replyContext}>
            <Ionicons
              name="return-down-forward"
              size={14}
              color={colors.text.secondary}
            />
            <Text style={styles.replyText} numberOfLines={1}>
              {`Replying to @${
                replyTo?.author.username ?? draftParentCast?.author.username
              }`}
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
                  ref={inputRef}
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

                {canSelectChannel && (
                  <View style={styles.channelPillRow}>
                    <Pressable
                      onPress={handleChannelPillPress}
                      disabled={isPublishing}
                      hitSlop={10}
                      style={[
                        styles.channelPill,
                        selectedChannelId && styles.channelPillSelected,
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={
                        selectedChannelId
                          ? `Posting to channel ${selectedChannelId}`
                          : "Select channel"
                      }
                    >
                      <Text
                        style={[
                          styles.channelPillText,
                          selectedChannelId && styles.channelPillTextSelected,
                        ]}
                        numberOfLines={1}
                      >
                        {selectedChannelId
                          ? `/${selectedChannelId}`
                          : "Channel"}
                      </Text>
                    </Pressable>
                    {selectedChannelId ? (
                      <Pressable
                        onPress={() => {
                          setSelectedChannelId(null);
                          channelSelectorTokenStartRef.current = null;
                        }}
                        hitSlop={8}
                        accessibilityLabel="Clear selected channel"
                        accessibilityRole="button"
                        style={styles.channelClear}
                      >
                        <Ionicons
                          name="close"
                          size={16}
                          color={colors.text.secondary}
                        />
                      </Pressable>
                    ) : null}
                  </View>
                )}

                {/* Voice note attachment preview */}
                {hasVoiceNote && (recorder.result || restoredVoice) && (
                  <View style={styles.voiceNotePreview}>
                    <Pressable
                      onPress={togglePreviewPlay}
                      disabled={!recorder.result}
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
                        peaks={
                          recorder.result?.peaks ??
                          restoredVoice?.waveform_peaks ??
                          []
                        }
                        progress={previewProgress}
                        height={32}
                      />
                    </View>
                    <Text style={styles.voiceNoteDuration}>
                      {formatTimer(
                        recorder.result?.durationMs ??
                          restoredVoice?.duration_ms ??
                          0,
                      )}
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

                {visibleQuoteCast && (
                  <View style={styles.quotePreview}>
                    <View style={styles.quotePreviewHeader}>
                      {visibleQuoteCast.author.pfp_url ? (
                        <Image
                          source={{ uri: visibleQuoteCast.author.pfp_url }}
                          style={styles.quotePreviewAvatar}
                          contentFit="cover"
                        />
                      ) : null}
                      <Text style={styles.quotePreviewName} numberOfLines={1}>
                        {visibleQuoteCast.author.display_name}
                      </Text>
                      <Text style={styles.quotePreviewUsername}>
                        @{visibleQuoteCast.author.username}
                      </Text>
                    </View>
                    <Text style={styles.quotePreviewText} numberOfLines={3}>
                      {visibleQuoteCast.text}
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
            <ChannelSuggestions
              enabled={canSelectChannel}
              text={text}
              cursorPosition={cursorPosition}
              onSelect={handleChannelSelect}
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

                {/* GIF button */}
                <Pressable
                  onPress={() => {
                    haptic.selection();
                    setGifPickerOpen(true);
                  }}
                  disabled={
                    isPublishing ||
                    hasVideo ||
                    hasVoiceNote ||
                    attachments.length >= maxImages
                  }
                  hitSlop={8}
                  style={[
                    styles.gifButton,
                    {
                      opacity:
                        hasVideo ||
                        hasVoiceNote ||
                        attachments.length >= maxImages
                          ? 0.4
                          : 1,
                    },
                  ]}
                  accessibilityLabel="Add GIF"
                  accessibilityRole="button"
                >
                  <Text style={styles.gifButtonText}>GIF</Text>
                </Pressable>

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
      <Modal
        visible={isDraftPickerOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setIsDraftPickerOpen(false)}
      >
        <Pressable
          style={styles.draftBackdrop}
          onPress={() => setIsDraftPickerOpen(false)}
        >
          <Pressable style={styles.draftSheet}>
            <View style={styles.draftSheetHeader}>
              <Text style={styles.draftSheetTitle}>Drafts</Text>
              <Pressable
                onPress={() => setIsDraftPickerOpen(false)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Close drafts"
              >
                <Ionicons
                  name="close"
                  size={22}
                  color={colors.text.secondary}
                />
              </Pressable>
            </View>
            {isLoadingDrafts ? (
              <View style={styles.draftEmpty}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : drafts.length === 0 ? (
              <View style={styles.draftEmpty}>
                <Text style={styles.draftEmptyTitle}>No drafts yet</Text>
                <Text style={styles.draftEmptyText}>
                  Saved casts, replies, and voice notes will show up here.
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.draftList}>
                {drafts.map((draft) => (
                  <Pressable
                    key={draft.id}
                    onPress={() => restoreDraft(draft)}
                    style={styles.draftRow}
                    accessibilityRole="button"
                    accessibilityLabel="Restore draft"
                  >
                    <View style={styles.draftRowMain}>
                      <Text style={styles.draftPreview} numberOfLines={2}>
                        {draft.text.trim() ||
                          (draft.voice_metadata
                            ? "Voice note draft"
                            : "Media draft")}
                      </Text>
                      <View style={styles.draftChips}>
                        {draft.parent_cast_hash ? (
                          <Text style={styles.draftChip}>Reply</Text>
                        ) : null}
                        {draft.quote_cast ? (
                          <Text style={styles.draftChip}>Quote</Text>
                        ) : null}
                        {draft.channel_id ? (
                          <Text style={styles.draftChip}>
                            /{draft.channel_id}
                          </Text>
                        ) : null}
                        {draft.media_embeds.length > 0 ? (
                          <Text style={styles.draftChip}>
                            {draft.media_embeds.length} media
                          </Text>
                        ) : null}
                        {draft.voice_metadata ? (
                          <Text style={styles.draftChip}>Voice</Text>
                        ) : null}
                      </View>
                    </View>
                    <View style={styles.draftRowSide}>
                      <Text style={styles.draftDate}>
                        {formatDraftTime(draft.updated_at)}
                      </Text>
                      <Pressable
                        onPress={() => handleDeleteDraft(draft)}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Delete draft"
                      >
                        <Ionicons
                          name="trash-outline"
                          size={19}
                          color={colors.danger}
                        />
                      </Pressable>
                    </View>
                  </Pressable>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>
      <GifPicker
        isVisible={gifPickerOpen}
        onClose={() => setGifPickerOpen(false)}
        onSelect={handleSelectGif}
      />
    </Modal>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
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
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 18,
  },
  cancelText: {
    color: colors.text.secondary,
    fontSize: 16,
  },
  draftsText: {
    color: colors.accent,
    fontSize: 16,
    fontWeight: "600",
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
  channelPillRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginLeft: -52,
    marginTop: 10,
    marginBottom: 4,
  },
  channelPill: {
    alignSelf: "flex-start",
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.background.subtle,
    borderRadius: 18,
    paddingHorizontal: 15,
    paddingVertical: 6,
    maxWidth: "78%",
  },
  channelPillSelected: {
    borderStyle: "solid",
    borderColor: colors.purple,
    backgroundColor: "rgba(133, 93, 205, 0.12)",
  },
  channelPillText: {
    color: colors.text.secondary,
    fontSize: 15,
    fontWeight: "600",
  },
  channelPillTextSelected: {
    color: colors.text.primary,
  },
  channelClear: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background.surface,
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
  gifButton: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.purple,
  },
  gifButtonText: {
    color: colors.purple,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.5,
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
  draftBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(0,0,0,0.46)",
  },
  draftSheet: {
    maxHeight: "70%",
    backgroundColor: colors.background.main,
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.background.border,
    paddingBottom: 20,
  },
  draftSheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
  },
  draftSheetTitle: {
    color: colors.text.primary,
    fontSize: 18,
    fontWeight: "700",
  },
  draftList: {
    maxHeight: 420,
  },
  draftRow: {
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.background.border,
  },
  draftRowMain: {
    flex: 1,
    gap: 8,
  },
  draftPreview: {
    color: colors.text.body,
    fontSize: 15,
    lineHeight: 20,
  },
  draftChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  draftChip: {
    color: colors.text.secondary,
    fontSize: 12,
    fontWeight: "600",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: colors.background.surface,
  },
  draftRowSide: {
    alignItems: "flex-end",
    justifyContent: "space-between",
    minHeight: 54,
  },
  draftDate: {
    color: colors.text.placeholder,
    fontSize: 12,
  },
  draftEmpty: {
    minHeight: 180,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
    gap: 8,
  },
  draftEmptyTitle: {
    color: colors.text.primary,
    fontSize: 17,
    fontWeight: "700",
  },
  draftEmptyText: {
    color: colors.text.secondary,
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  }));
