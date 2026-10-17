import { useState, useEffect, useRef, useCallback } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Keyboard,
  KeyboardAvoidingView,
  Animated,
  ActivityIndicator,
  ScrollView,
  Alert,
  Switch,
  Platform,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import Toast from "react-native-toast-message";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import {
  getErrorMessage,
  publishCastToChannel,
  uploadImage,
  uploadVideo,
} from "@/services/api";
import {
  MAX_SCHEDULE_HORIZON_MS,
  MIN_SCHEDULE_DELAY_MS,
  createScheduledCast,
  defaultScheduledDate,
  formatScheduledDate,
  mergeLocalDate,
  mergeLocalTime,
  validateScheduledDate,
  validateScheduledEmbedCount,
} from "@/services/scheduledCasts";
import * as draftsApi from "@/services/drafts";
import { useAuthStore } from "@/stores/authStore";
import { useVoiceNoteStore } from "@/stores/voiceNoteStore";
import { useVoiceNoteRecorder } from "@/hooks/useVoiceNoteRecorder";
import * as voiceNotesApi from "@/services/voiceNotes";
import { publishCastThread, type ThreadCastSegment } from "@/services/feed";
import { refreshSharedFeed } from "@/hooks/useFeed";
import { Avatar } from "@/components/common/Avatar";
import { MentionSuggestions } from "@/components/common/MentionSuggestions";
import { ChannelSuggestions } from "@/components/feed/ChannelSuggestions";
import { GifPicker } from "@/components/feed/GifPicker";
import {
  ThreadSegmentItem,
  type ComposeAttachment,
  type ThreadSegment,
} from "@/components/feed/ThreadSegmentItem";
import { Waveform } from "@/components/voice-notes/Waveform";
import { useOgPreview, extractUrls } from "@/hooks/useOgPreview";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { haptic } from "@/utils/haptics";
import { utf8ByteLength } from "@/utils/castText";
import type {
  ComposeDraft,
  ComposeDraftPayload,
  DraftCastSnapshot,
  DraftMediaEmbed,
  DraftQuoteCast,
  DraftVoiceMetadata,
} from "@/types/draft";
import type { GiphyGif } from "@/services/giphy";
import type { FarcasterCast } from "@/types/farcaster";

// Farcaster cast limits are enforced in UTF-8 bytes, not characters.
const CAST_LENGTH_DEFAULT = 1024;
const CAST_LENGTH_PRO = 10000;
const MAX_IMAGES_DEFAULT = 2;
const MAX_IMAGES_PRO = 4;
const MAX_EMBEDS_PER_CAST = 4;
const MAX_THREAD_SEGMENTS = 10;
const COMPOSE_INPUT_MIN_HEIGHT = 120;
const CHANNEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

type RecordingState = "idle" | "recording" | "recorded";

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
   * Called after a reply successfully posts outside the onPublish path
   * (voice replies and cast-thread replies). Lets the parent screen refresh
   * its thread so the new reply appears under the parent cast. Separate from
   * onPublish because those flows publish via their own endpoints.
   */
  onVoiceReplyPosted?: (parentHash: string) => void | Promise<void>;
  replyTo?: FarcasterCast | null;
  quoteCast?: FarcasterCast | null;
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
  const { colors, scheme } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const user = useAuthStore((s) => s.user);
  const isPro = user?.is_pro ?? false;
  const maxCastLength = isPro ? CAST_LENGTH_PRO : CAST_LENGTH_DEFAULT;
  const maxImages = isPro ? MAX_IMAGES_PRO : MAX_IMAGES_DEFAULT;
  const [text, setText] = useState("");
  const [cursorPosition, setCursorPosition] = useState(0);
  const [attachments, setAttachments] = useState<ComposeAttachment[]>([]);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(defaultScheduledDate);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [androidPickerMode, setAndroidPickerMode] = useState<
    "date" | "time" | null
  >(null);
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
  // Set after a partial thread failure: the quote already rode along with the
  // published first cast, so the remaining segments must not re-attach it.
  const [isQuoteConsumed, setIsQuoteConsumed] = useState(false);
  // Set after a partial thread failure: the remaining tail must continue
  // under the last published cast instead of the original parent/channel.
  const [threadRetryParentHash, setThreadRetryParentHash] = useState<
    string | null
  >(null);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    null,
  );
  const inputRef = useRef<TextInput>(null);
  const bodyScrollRef = useRef<ScrollView>(null);
  const channelSelectorTokenStartRef = useRef<number | null>(null);
  const submitLockRef = useRef(false);
  const keyboardPadding = useRef(new Animated.Value(0)).current;

  // --- Thread composition ---
  // Segment 0 is the existing `text`/`attachments` state; segments after the
  // first live in `threadSegments`. `activeSegmentIndex` (0-based across the
  // whole thread) tracks which segment the footer media/GIF actions target.
  const [threadSegments, setThreadSegments] = useState<ThreadSegment[]>([]);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [lastAddedSegmentId, setLastAddedSegmentId] = useState<string | null>(
    null,
  );
  const segmentIdRef = useRef(0);
  const hasThreadSegments = threadSegments.length > 0;
  const totalSegments = threadSegments.length + 1;

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

  const effectiveQuoteCast = isQuoteConsumed ? null : (quoteCast ?? null);
  const hasRecordedVoiceNote =
    recordingState === "recorded" && !!recorder.result;
  const hasVoiceNote = hasRecordedVoiceNote || !!restoredVoice;
  const effectiveDraftQuote = isQuoteConsumed ? null : draftQuoteCast;
  // UI gating: a pending 207 continuation (retry anchor set, possibly only
  // one segment left) must stay in thread mode so it can't be draft-saved,
  // voice-noted, or scheduled — any of those would fork or mis-anchor the
  // already-published prefix. Publish branching uses hasThreadSegments.
  const isThreadMode = hasThreadSegments || threadRetryParentHash !== null;
  const activeParentHash = replyTo?.hash ?? draftParentCast?.hash;
  // Publish target: after a partial thread failure the tail continues under
  // the last published cast, not under the original parent (or channel root).
  const effectiveParentHash = threadRetryParentHash ?? activeParentHash;
  const canSelectChannel =
    !effectiveParentHash && (!hasVoiceNote || postToFarcaster);
  const effectiveChannelId = canSelectChannel ? selectedChannelId : null;

  // Footer media/GIF actions and the counter target the active segment.
  const activeThreadSegment =
    activeSegmentIndex > 0
      ? (threadSegments[activeSegmentIndex - 1] ?? null)
      : null;
  const activeText = activeThreadSegment ? activeThreadSegment.text : text;
  const activeAttachments = activeThreadSegment
    ? activeThreadSegment.attachments
    : attachments;
  const activeHasVideo = activeAttachments.some((a) => a.type === "video");

  const byteCount = utf8ByteLength(activeText);
  const isFirstSegmentOverLimit = utf8ByteLength(text) > maxCastLength;
  const isActiveOverLimit = byteCount > maxCastLength;
  const anySegmentOverLimit =
    isFirstSegmentOverLimit ||
    threadSegments.some((s) => utf8ByteLength(s.text) > maxCastLength);
  const everyThreadSegmentHasContent = threadSegments.every(
    (s) => s.text.trim().length > 0 || s.attachments.length > 0,
  );
  const hasContent =
    text.trim().length > 0 ||
    attachments.length > 0 ||
    threadSegments.some(
      (s) => s.text.trim().length > 0 || s.attachments.length > 0,
    ) ||
    hasVoiceNote ||
    !!effectiveQuoteCast ||
    !!effectiveDraftQuote;
  const firstSegmentHasContent =
    text.trim().length > 0 ||
    attachments.length > 0 ||
    hasVoiceNote ||
    !!effectiveQuoteCast ||
    !!effectiveDraftQuote;
  const canPublish =
    hasContent &&
    (!isThreadMode || (firstSegmentHasContent && everyThreadSegmentHasContent)) &&
    !anySegmentOverLimit &&
    !isPublishing &&
    !isSavingDraft &&
    recordingState !== "recording";
  const activeSegmentHasContent = activeThreadSegment
    ? activeThreadSegment.text.trim().length > 0 ||
      activeThreadSegment.attachments.length > 0
    : firstSegmentHasContent;
  const canAddThreadSegment =
    activeSegmentHasContent &&
    !hasVoiceNote &&
    !isScheduleOpen &&
    !activeDraft &&
    !isPublishing &&
    !isSavingDraft &&
    recordingState === "idle" &&
    totalSegments < MAX_THREAD_SEGMENTS;
  const visibleQuote = effectiveQuoteCast ?? effectiveDraftQuote;
  const scheduleValidation = validateScheduledDate(scheduledDate);
  const scheduledEmbedCount =
    attachments.length + extractUrls(text.trim()).length;
  const scheduledEmbedError = validateScheduledEmbedCount(
    scheduledEmbedCount,
    !!visibleQuote,
  );
  const scheduleUnavailableReason = hasVoiceNote
    ? "Voice notes can’t be scheduled yet."
    : isThreadMode
      ? "Threads can’t be scheduled yet."
      : activeDraft
        ? "Publish saved drafts immediately, or start a new cast to schedule."
        : null;
  const canSchedule =
    canPublish &&
    !scheduleUnavailableReason &&
    !scheduledEmbedError &&
    scheduleValidation.ok;

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
    if (effectiveParentHash || (hasVoiceNote && !postToFarcaster)) {
      setSelectedChannelId(null);
      channelSelectorTokenStartRef.current = null;
    }
  }, [effectiveParentHash, hasVoiceNote, postToFarcaster]);

  // --- Voice recording handlers ---

  const handleStartRecording = useCallback(async () => {
    // Voice notes stay single-cast; the mic is hidden in thread mode, but
    // guard anyway so a stale press can't attach a recording to a thread.
    if (isThreadMode) return;
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
    setIsScheduleOpen(false);
    setScheduleError(null);
    setAndroidPickerMode(null);
    // Clear media attachments — voice note replaces images/video
    setAttachments([]);
    setRestoredVoice(null);
    await recorder.startRecording();
    setRecordingState("recording");
  }, [isThreadMode, recorder]);

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

  // --- Thread segment handlers ---

  const handleAddThreadSegment = useCallback(() => {
    if (!canAddThreadSegment) return;
    haptic.selection();
    segmentIdRef.current += 1;
    const id = `segment-${segmentIdRef.current}`;
    const insertAt = activeSegmentIndex; // position within threadSegments
    const isAppendingAtEnd = insertAt === threadSegments.length;
    setThreadSegments((prev) => [
      ...prev.slice(0, insertAt),
      { id, text: "", attachments: [] },
      ...prev.slice(insertAt),
    ]);
    setActiveSegmentIndex(insertAt + 1);
    setLastAddedSegmentId(id);
    if (isAppendingAtEnd) {
      // Bring the new (auto-focused) segment above the keyboard; a plain
      // ScrollView won't scroll a newly focused input into view on its own.
      requestAnimationFrame(() => {
        bodyScrollRef.current?.scrollToEnd({ animated: true });
      });
    }
  }, [activeSegmentIndex, canAddThreadSegment, threadSegments.length]);

  const removeThreadSegment = useCallback(
    (id: string) => {
      // Whole-thread index of the removed segment (segment 0 is the main
      // input, so extras are offset by one).
      const removedIndex = threadSegments.findIndex((s) => s.id === id) + 1;
      if (removedIndex <= 0) return;
      const nextLength = threadSegments.length - 1;
      setThreadSegments((prev) => prev.filter((s) => s.id !== id));
      setActiveSegmentIndex((current) => {
        // Removing a segment above the active one shifts it down by one;
        // otherwise just clamp into the shorter thread.
        if (current > removedIndex) return current - 1;
        return Math.min(current, nextLength);
      });
    },
    [threadSegments],
  );

  const handleRemoveThreadSegment = useCallback(
    (id: string) => {
      const segment = threadSegments.find((s) => s.id === id);
      if (!segment) return;
      const hasSegmentContent =
        segment.text.trim().length > 0 || segment.attachments.length > 0;
      if (!hasSegmentContent) {
        haptic.light();
        removeThreadSegment(id);
        return;
      }
      Alert.alert(
        "Remove this cast?",
        "Its text and attachments will be discarded.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => removeThreadSegment(id),
          },
        ],
      );
    },
    [removeThreadSegment, threadSegments],
  );

  const handleThreadSegmentTextChange = useCallback(
    (id: string, nextText: string) => {
      setThreadSegments((prev) =>
        prev.map((s) => (s.id === id ? { ...s, text: nextText } : s)),
      );
    },
    [],
  );

  const handleThreadSegmentFocus = useCallback(
    (id: string) => {
      const index = threadSegments.findIndex((s) => s.id === id);
      if (index >= 0) setActiveSegmentIndex(index + 1);
    },
    [threadSegments],
  );

  const handleRemoveThreadSegmentAttachment = useCallback(
    (id: string, attachmentIndex: number) => {
      setThreadSegments((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                attachments: s.attachments.filter(
                  (_, i) => i !== attachmentIndex,
                ),
              }
            : s,
        ),
      );
    },
    [],
  );

  // --- Media handlers (act on the active segment) ---

  const updateActiveAttachments = useCallback(
    (updater: (prev: ComposeAttachment[]) => ComposeAttachment[]) => {
      if (activeThreadSegment) {
        const id = activeThreadSegment.id;
        setThreadSegments((prev) =>
          prev.map((s) =>
            s.id === id ? { ...s, attachments: updater(s.attachments) } : s,
          ),
        );
        return;
      }
      setAttachments(updater);
    },
    [activeThreadSegment],
  );

  const handlePickMedia = async () => {
    if (activeHasVideo || hasVoiceNote || activeAttachments.length >= maxImages)
      return;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images", "videos"],
      quality: 0.8,
      selectionLimit: maxImages - activeAttachments.length,
      allowsMultipleSelection: true,
    });

    if (!result.canceled) {
      const newAttachments = result.assets.map((a) => ({
        uri: a.uri,
        type: (a.type === "video" ? "video" : "image") as "image" | "video",
        source: "local" as const,
      }));

      const hasNewVideo = newAttachments.some((a) => a.type === "video");
      if (hasNewVideo) {
        updateActiveAttachments(() => [
          newAttachments.find((a) => a.type === "video")!,
        ]);
      } else {
        updateActiveAttachments((prev) =>
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
      updateActiveAttachments((prev) =>
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
    [maxImages, updateActiveAttachments],
  );

  const castToDraftSnapshot = useCallback(
    (cast: FarcasterCast): DraftCastSnapshot => ({
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
    (cast: FarcasterCast): DraftQuoteCast => ({
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
      const quote = effectiveQuoteCast
        ? quoteToDraftSnapshot(effectiveQuoteCast)
        : effectiveDraftQuote;
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
      effectiveChannelId,
      effectiveDraftQuote,
      effectiveQuoteCast,
      hasRecordedVoiceNote,
      postToFarcaster,
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
    setIsScheduleOpen(false);
    setScheduleError(null);
    setAndroidPickerMode(null);
    // Drafts are single-cast; restoring one replaces any thread in progress
    // (the Drafts button is disabled in thread mode, this is defensive).
    setThreadSegments([]);
    setActiveSegmentIndex(0);
    setLastAddedSegmentId(null);
    setThreadRetryParentHash(null);
    setIsQuoteConsumed(false);
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

  const uploadSegmentAttachments = useCallback(
    async (
      segmentAttachments: ComposeAttachment[],
    ): Promise<ComposeAttachment[]> =>
      Promise.all(
        segmentAttachments.map(async (attachment) => {
          if (
            attachment.source === "giphy" ||
            attachment.source === "uploaded"
          ) {
            return attachment;
          }
          const url =
            attachment.type === "video"
              ? await uploadVideo(attachment.uri)
              : await uploadImage(attachment.uri);
          return { ...attachment, uri: url, source: "uploaded" as const };
        }),
      ),
    [],
  );

  const handlePublish = async () => {
    if (!canPublish || submitLockRef.current) return;
    submitLockRef.current = true;
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
      if (hasThreadSegments) {
        const sourceSegments = [
          { text, attachments },
          ...threadSegments.map((s) => ({
            text: s.text,
            attachments: s.attachments,
          })),
        ];
        // Upload each segment's local media first; giphy and already-uploaded
        // URIs pass through unchanged.
        const uploadedSegments = await Promise.all(
          sourceSegments.map(async (segment) => ({
            text: segment.text.trim(),
            attachments: await uploadSegmentAttachments(segment.attachments),
          })),
        );
        const quote = effectiveQuoteCast
          ? { fid: effectiveQuoteCast.author.fid, hash: effectiveQuoteCast.hash }
          : effectiveDraftQuote
            ? { fid: effectiveDraftQuote.fid, hash: effectiveDraftQuote.hash }
            : undefined;
        const casts: ThreadCastSegment[] = uploadedSegments.map(
          (segment, i) => {
            const embeds = [
              ...segment.attachments.map((a) => a.uri),
              ...extractUrls(segment.text),
            ].slice(0, MAX_EMBEDS_PER_CAST);
            return {
              text: segment.text,
              ...(embeds.length > 0 ? { embeds } : {}),
              ...(i === 0 && quote ? { quote } : {}),
            };
          },
        );
        const result = await publishCastThread({
          casts,
          parent: effectiveParentHash,
          channelId:
            !effectiveParentHash && effectiveChannelId
              ? effectiveChannelId
              : undefined,
        });

        if (!result.success) {
          const failedIndex = result.failed_index ?? 0;
          if (
            !Number.isInteger(failedIndex) ||
            failedIndex <= 0 ||
            failedIndex >= sourceSegments.length
          ) {
            // Root failure shouldn't reach here (backend returns 502), and a
            // malformed failed_index must not slice away the user's segments.
            // Treat both like a full failure: keep everything.
            throw new Error(result.error ?? "Failed to publish thread");
          }
          // Keep the unpublished tail in the composer. Attachments are kept
          // in their uploaded form so retrying won't re-upload media.
          const remaining = uploadedSegments.slice(failedIndex);
          const [first, ...rest] = remaining;
          setText(first?.text ?? "");
          setCursorPosition((first?.text ?? "").length);
          setAttachments(first?.attachments ?? []);
          setThreadSegments(
            rest.map((segment) => {
              segmentIdRef.current += 1;
              return {
                id: `segment-${segmentIdRef.current}`,
                text: segment.text,
                attachments: segment.attachments,
              };
            }),
          );
          setActiveSegmentIndex(0);
          setLastAddedSegmentId(null);
          // The quote rode along with the published first cast; don't attach
          // it again when the remaining segments are re-published.
          if (quote) setIsQuoteConsumed(true);
          // Retries must continue under the last published cast rather than
          // re-anchoring on the original parent (or channel root), which
          // would fork the thread.
          const lastPublishedHash =
            result.casts.find((c) => c.index === failedIndex - 1)?.hash ??
            result.casts[result.casts.length - 1]?.hash ??
            null;
          if (lastPublishedHash) setThreadRetryParentHash(lastPublishedHash);
          haptic.error();
          Alert.alert(
            "Thread partially posted",
            `Posted ${failedIndex} of ${sourceSegments.length} casts — the rest failed.`,
          );
          void refreshSharedFeed();
          if (effectiveParentHash && onVoiceReplyPosted) {
            // The published prefix did land under the parent; let the thread
            // screen refresh even though the tail is still in the composer.
            void Promise.resolve(
              onVoiceReplyPosted(effectiveParentHash),
            ).catch(() => {});
          }
          return;
        }

        const rootHash = result.casts.find((c) => c.index === 0)?.hash;
        if (rootHash) {
          Toast.show({
            type: "viewCast",
            props: { hash: rootHash, parentHash: effectiveParentHash },
            visibilityTime: 5000,
            position: "bottom",
          });
        }
        haptic.success();
        await refreshSharedFeed();
        if (effectiveParentHash && onVoiceReplyPosted) {
          try {
            await onVoiceReplyPosted(effectiveParentHash);
          } catch {
            // Non-fatal: the thread already published; refresh is best-effort.
          }
        }
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
          parent_cast_hash: effectiveParentHash,
          channel_id:
            postToFarcaster && !effectiveParentHash && effectiveChannelId
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

        if (effectiveParentHash && onVoiceReplyPosted) {
          try {
            await onVoiceReplyPosted(effectiveParentHash);
          } catch {
            // Non-fatal: the voice note was already posted; refresh is best-effort.
          }
        }
      } else {
        // Normal cast publish flow
        let uploadedUrls: string[] | undefined;
        if (attachments.length > 0) {
          // uploadSegmentAttachments skips giphy and already-uploaded URIs
          // (e.g. the tail kept after a partial thread failure).
          const uploaded = await uploadSegmentAttachments(attachments);
          uploadedUrls = uploaded.map((a) => a.uri);
        }

        const textUrls = extractUrls(text.trim());
        const allEmbeds = [...(uploadedUrls ?? []), ...textUrls].slice(
          0,
          MAX_EMBEDS_PER_CAST,
        );

        const quote = effectiveQuoteCast
          ? { fid: effectiveQuoteCast.author.fid, hash: effectiveQuoteCast.hash }
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
              effectiveParentHash,
              allEmbeds.length > 0 ? allEmbeds : undefined,
              quote,
              effectiveChannelId ?? undefined,
            );
        if (result?.hash) {
          Toast.show({
            type: "viewCast",
            props: { hash: result.hash, parentHash: effectiveParentHash },
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
      if (__DEV__) console.error("[Compose] Failed to publish:", detail);
      haptic.error();
      Toast.show({
        type: "error",
        text1: "Error",
        text2: `Failed to publish: ${detail}`,
      });
    } finally {
      setIsPublishing(false);
      submitLockRef.current = false;
    }
  };

  const handleSchedule = async () => {
    if (submitLockRef.current) return;

    // Revalidate at tap time: an open picker can cross the minimum boundary
    // without causing a render.
    const validation = validateScheduledDate(scheduledDate);
    if (!validation.ok) {
      setScheduleError(validation.error);
      haptic.error();
      return;
    }
    if (scheduleUnavailableReason) {
      setScheduleError(scheduleUnavailableReason);
      haptic.error();
      return;
    }

    const quote = effectiveQuoteCast
      ? { fid: effectiveQuoteCast.author.fid, hash: effectiveQuoteCast.hash }
      : effectiveDraftQuote
        ? { fid: effectiveDraftQuote.fid, hash: effectiveDraftQuote.hash }
        : undefined;
    const textUrls = extractUrls(text.trim());
    const embedError = validateScheduledEmbedCount(
      attachments.length + textUrls.length,
      !!quote,
    );
    if (embedError) {
      setScheduleError(embedError);
      haptic.error();
      return;
    }
    if (!hasContent || isFirstSegmentOverLimit || recordingState === "recording")
      return;

    submitLockRef.current = true;
    setIsPublishing(true);
    setScheduleError(null);
    Keyboard.dismiss();
    haptic.light();

    try {
      const uploadedUrls = await Promise.all(
        attachments.map((attachment) => {
          if (attachment.source === "giphy") {
            return Promise.resolve(attachment.uri);
          }
          if (attachment.source === "uploaded") {
            return Promise.resolve(attachment.uri);
          }
          return attachment.type === "video"
            ? uploadVideo(attachment.uri)
            : uploadImage(attachment.uri);
        }),
      );
      const embeds = [...uploadedUrls, ...textUrls];

      await createScheduledCast({
        text: text.trim(),
        ...(effectiveParentHash ? { parent: effectiveParentHash } : {}),
        ...(embeds.length > 0 ? { embeds } : {}),
        ...(quote ? { quote } : {}),
        ...(!effectiveParentHash && effectiveChannelId
          ? { channel_id: effectiveChannelId }
          : {}),
        scheduled_for: validation.utcIso,
      });

      haptic.success();
      Toast.show({
        type: "success",
        text1: "Cast scheduled",
        text2: formatScheduledDate(validation.date),
        visibilityTime: 5000,
      });
      resetState();
      onClose();
    } catch (err) {
      const detail = getErrorMessage(err);
      setScheduleError(detail);
      haptic.error();
      Toast.show({
        type: "error",
        text1: "Couldn’t schedule cast",
        text2: detail,
      });
    } finally {
      setIsPublishing(false);
      submitLockRef.current = false;
    }
  };

  const resetState = useCallback(() => {
    setText("");
    setAttachments([]);
    setThreadSegments([]);
    setActiveSegmentIndex(0);
    setLastAddedSegmentId(null);
    setIsQuoteConsumed(false);
    setThreadRetryParentHash(null);
    setRecordingState("idle");
    setPostToFarcaster(true);
    setSelectedChannelId(null);
    setActiveDraft(null);
    setDraftParentCast(null);
    setDraftQuoteCast(null);
    setRestoredVoice(null);
    setIsDraftPickerOpen(false);
    setIsScheduleOpen(false);
    setScheduledDate(defaultScheduledDate());
    setScheduleError(null);
    setAndroidPickerMode(null);
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
    if (isThreadMode) {
      // Drafts are single-cast, so a thread can only be kept open or discarded.
      Alert.alert("Discard thread?", "All casts in this thread will be lost.", [
        { text: "Keep editing", style: "cancel" },
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

  const handleToggleSchedule = () => {
    if (isPublishing || isSavingDraft) return;
    if (isScheduleOpen) {
      setIsScheduleOpen(false);
      setScheduleError(null);
      setAndroidPickerMode(null);
      return;
    }
    if (scheduleUnavailableReason) {
      haptic.error();
      Toast.show({
        type: "info",
        text1: "Can’t schedule this one",
        text2: scheduleUnavailableReason,
      });
      return;
    }
    haptic.selection();
    Keyboard.dismiss();
    if (!validateScheduledDate(scheduledDate).ok) {
      setScheduledDate(defaultScheduledDate());
    }
    setScheduleError(null);
    setIsScheduleOpen(true);
  };

  const handleAndroidPickerChange = (
    event: DateTimePickerEvent,
    selected?: Date,
  ) => {
    const mode = androidPickerMode;
    setAndroidPickerMode(null);
    if (event.type === "dismissed" || !selected || !mode) return;
    setScheduledDate((current) =>
      mode === "date"
        ? mergeLocalDate(current, selected)
        : mergeLocalTime(current, selected),
    );
    setScheduleError(null);
  };

  const immediatePublishLabel = isThreadMode
    ? hasThreadSegments
      ? "Cast all"
      : "Continue"
    : hasVoiceNote
      ? "Post"
      : effectiveParentHash
        ? "Reply"
        : effectiveQuoteCast || effectiveDraftQuote
          ? "Quote"
          : "Cast";
  const publishLabel = isScheduleOpen ? "Schedule" : immediatePublishLabel;
  const canPrimarySubmit = isScheduleOpen ? canSchedule : canPublish;
  const scheduleStatusMessage =
    scheduleError ??
    scheduledEmbedError ??
    (scheduleValidation.ok ? null : scheduleValidation.error);
  const visibleQuoteCast = effectiveQuoteCast
    ? {
        author: effectiveQuoteCast.author,
        text: effectiveQuoteCast.text,
      }
    : effectiveDraftQuote?.author
      ? {
          author: effectiveDraftQuote.author,
          text: effectiveDraftQuote.text,
        }
      : null;

  return (
    <Modal
      visible={isVisible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={handleClose}
      statusBarTranslucent={false}
    >
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        // iOS uses the manual Animated paddingBottom below (driven by
        // keyboardWillShow). Android's keyboardWillShow doesn't fire, so the
        // animation is a no-op there — KeyboardAvoidingView with behavior
        // "padding" handles keyboard avoidance instead.
        behavior={Platform.OS === "android" ? "padding" : undefined}
      >
      <Animated.View
        style={[
          styles.container,
          { paddingBottom: keyboardPadding },
          // Android Modals ignore presentationStyle="pageSheet" and render
          // edge-to-edge, so the status bar overlaps content. Pad it out.
          Platform.OS === "android" && { paddingTop: insets.top },
        ]}
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
              // Drafts are single-cast; restoring one would clobber a thread.
              disabled={isPublishing || isSavingDraft || isThreadMode}
              accessibilityRole="button"
              accessibilityLabel="Open drafts"
              accessibilityState={{
                disabled: isPublishing || isSavingDraft || isThreadMode,
              }}
              style={{ opacity: isThreadMode ? 0.4 : 1 }}
            >
              <Text style={styles.draftsText}>Drafts</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={isScheduleOpen ? handleSchedule : handlePublish}
            style={[
              styles.publishButton,
              !canPrimarySubmit && styles.publishButtonDisabled,
            ]}
            disabled={!canPrimarySubmit}
            accessibilityRole="button"
            accessibilityLabel={publishLabel}
            accessibilityState={{
              disabled: !canPrimarySubmit,
              busy: isPublishing,
            }}
          >
            {isPublishing ? (
              <ActivityIndicator size="small" color={colors.text.primary} />
            ) : (
              <Text
                style={[
                  styles.publishText,
                  !canPrimarySubmit && styles.publishTextDisabled,
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
            {/* Compose body scrolls so long casts, previews, and thread
                segments never squeeze the input area. */}
            <ScrollView
              ref={bodyScrollRef}
              style={styles.bodyScroll}
              contentContainerStyle={styles.bodyScrollContent}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            >
            <View style={styles.composeArea}>
              <View style={styles.avatarColumn}>
                <Avatar
                  pfpUrl={user?.pfp_url ?? null}
                  displayName={user?.display_name ?? ""}
                  size="md"
                />
                {hasThreadSegments && <View style={styles.threadRail} />}
              </View>
              <View style={styles.inputArea}>
                <TextInput
                  ref={inputRef}
                  style={styles.input}
                  placeholder={
                    hasVoiceNote
                      ? "Add a caption (optional)"
                      : effectiveQuoteCast
                        ? "Add a comment..."
                        : replyTo
                          ? "Post your reply"
                          : "What's happening?"
                  }
                  placeholderTextColor={colors.text.placeholder}
                  multiline
                  scrollEnabled={false}
                  autoFocus={!hasVoiceNote}
                  maxLength={maxCastLength + 50}
                  value={text}
                  onChangeText={(t) => {
                    setText(t);
                    setCursorPosition(t.length);
                  }}
                  onFocus={() => setActiveSegmentIndex(0)}
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
                      <View
                        key={`${attachment.uri}-${i}`}
                        style={styles.previewWrapper}
                      >
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

            {threadSegments.map((segment, i) => (
              <ThreadSegmentItem
                key={segment.id}
                segment={segment}
                displayIndex={i + 2}
                totalSegments={totalSegments}
                maxCastLength={maxCastLength}
                autoFocus={segment.id === lastAddedSegmentId}
                editable={!isPublishing}
                onChangeText={handleThreadSegmentTextChange}
                onFocus={handleThreadSegmentFocus}
                onRemove={handleRemoveThreadSegment}
                onRemoveAttachment={handleRemoveThreadSegmentAttachment}
              />
            ))}
            </ScrollView>

            {/* Suggestions read the main input's text/cursor, so they only
                apply while the first segment is active. */}
            {activeSegmentIndex === 0 && (
              <MentionSuggestions
                text={text}
                cursorPosition={cursorPosition}
                onSelect={handleMentionSelect}
              />
            )}
            <ChannelSuggestions
              enabled={canSelectChannel && activeSegmentIndex === 0}
              text={text}
              cursorPosition={cursorPosition}
              onSelect={handleChannelSelect}
            />

            {isScheduleOpen && (
              <View style={styles.schedulePanel}>
                <View style={styles.scheduleHeader}>
                  <View style={styles.scheduleTitleRow}>
                    <View style={styles.scheduleIcon}>
                      <Ionicons
                        name="time-outline"
                        size={18}
                        color={colors.accent}
                      />
                    </View>
                    <View style={styles.scheduleHeadingGroup}>
                      <Text style={styles.scheduleTitle}>Play it later</Text>
                      <Text style={styles.scheduleSubtitle}>
                        Uses your local time zone
                      </Text>
                    </View>
                  </View>
                  <Pressable
                    onPress={handleToggleSchedule}
                    style={styles.scheduleClose}
                    accessibilityRole="button"
                    accessibilityLabel="Close scheduling options"
                  >
                    <Ionicons
                      name="close"
                      size={20}
                      color={colors.text.secondary}
                    />
                  </Pressable>
                </View>

                {Platform.OS === "ios" ? (
                  <View style={styles.iosPickerRow}>
                    <DateTimePicker
                      value={scheduledDate}
                      mode="datetime"
                      display="compact"
                      minimumDate={new Date(Date.now() + MIN_SCHEDULE_DELAY_MS)}
                      maximumDate={new Date(
                        Date.now() + MAX_SCHEDULE_HORIZON_MS,
                      )}
                      onChange={(_event, date) => {
                        if (!date) return;
                        setScheduledDate(date);
                        setScheduleError(null);
                      }}
                      textColor={colors.text.primary}
                      accentColor={colors.accent}
                      themeVariant={scheme}
                    />
                  </View>
                ) : (
                  <View style={styles.androidPickerRow}>
                    <Pressable
                      onPress={() => setAndroidPickerMode("date")}
                      style={styles.androidPickerButton}
                      accessibilityRole="button"
                      accessibilityLabel={`Choose date, currently ${scheduledDate.toLocaleDateString()}`}
                    >
                      <Text style={styles.androidPickerLabel}>Date</Text>
                      <Text style={styles.androidPickerValue}>
                        {scheduledDate.toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() => setAndroidPickerMode("time")}
                      style={styles.androidPickerButton}
                      accessibilityRole="button"
                      accessibilityLabel={`Choose time, currently ${scheduledDate.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}
                    >
                      <Text style={styles.androidPickerLabel}>Time</Text>
                      <Text style={styles.androidPickerValue}>
                        {scheduledDate.toLocaleTimeString(undefined, {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </Text>
                    </Pressable>
                  </View>
                )}

                {Platform.OS === "android" && androidPickerMode && (
                  <DateTimePicker
                    value={scheduledDate}
                    mode={androidPickerMode}
                    display="default"
                    minimumDate={
                      androidPickerMode === "date"
                        ? new Date(Date.now() + MIN_SCHEDULE_DELAY_MS)
                        : undefined
                    }
                    maximumDate={
                      androidPickerMode === "date"
                        ? new Date(Date.now() + MAX_SCHEDULE_HORIZON_MS)
                        : undefined
                    }
                    onChange={handleAndroidPickerChange}
                    themeVariant={scheme}
                  />
                )}

                <Text
                  style={[
                    styles.scheduleStatus,
                    scheduleStatusMessage && styles.scheduleStatusError,
                  ]}
                  accessibilityLiveRegion="polite"
                >
                  {scheduleStatusMessage ??
                    `Will cast ${formatScheduledDate(scheduledDate)}.`}
                </Text>
              </View>
            )}

            {/* Footer */}
            <View
              style={[
                styles.footer,
                { paddingBottom: Math.max(12, insets.bottom) },
              ]}
            >
              <View style={styles.footerLeft}>
                <Pressable
                  onPress={handlePickMedia}
                  disabled={
                    isPublishing ||
                    activeHasVideo ||
                    hasVoiceNote ||
                    activeAttachments.length >= maxImages
                  }
                  hitSlop={8}
                  style={{
                    opacity:
                      activeHasVideo ||
                      hasVoiceNote ||
                      activeAttachments.length >= maxImages
                        ? 0.4
                        : 1,
                  }}
                  accessibilityLabel="Add media"
                  accessibilityRole="button"
                  accessibilityState={{
                    disabled:
                      isPublishing ||
                      activeHasVideo ||
                      hasVoiceNote ||
                      activeAttachments.length >= maxImages,
                  }}
                >
                  <Ionicons
                    name="image-outline"
                    size={24}
                    color={colors.purple}
                  />
                </Pressable>
                {activeAttachments.length > 0 && (
                  <Text style={styles.imageHint}>
                    {activeHasVideo
                      ? "Video"
                      : `${activeAttachments.length}/${maxImages}`}
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
                    activeHasVideo ||
                    hasVoiceNote ||
                    activeAttachments.length >= maxImages
                  }
                  hitSlop={8}
                  style={[
                    styles.gifButton,
                    {
                      opacity:
                        activeHasVideo ||
                        hasVoiceNote ||
                        activeAttachments.length >= maxImages
                          ? 0.4
                          : 1,
                    },
                  ]}
                  accessibilityLabel="Add GIF"
                  accessibilityRole="button"
                >
                  <Text style={styles.gifButtonText}>GIF</Text>
                </Pressable>

                {/* Mic button (voice notes stay single-cast) */}
                {!isThreadMode && (
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
                )}

                {/* Schedule button (scheduled casts stay single-cast) */}
                {!isThreadMode && (
                  <Pressable
                    onPress={handleToggleSchedule}
                    disabled={isPublishing || isSavingDraft}
                    style={({ pressed }) => [
                      styles.scheduleToggle,
                      isScheduleOpen && styles.scheduleToggleActive,
                      pressed && styles.scheduleTogglePressed,
                      (isPublishing || isSavingDraft) &&
                        styles.scheduleToggleDisabled,
                    ]}
                    accessibilityLabel={
                      isScheduleOpen
                        ? "Scheduling enabled"
                        : "Schedule cast for later"
                    }
                    accessibilityHint={
                      scheduleUnavailableReason ??
                      "Opens local date and time controls"
                    }
                    accessibilityRole="button"
                    accessibilityState={{
                      selected: isScheduleOpen,
                      disabled: isPublishing || isSavingDraft,
                    }}
                  >
                    <Ionicons
                      name={isScheduleOpen ? "time" : "time-outline"}
                      size={23}
                      color={
                        isScheduleOpen ? colors.text.primary : colors.purple
                      }
                    />
                  </Pressable>
                )}

                {/* Add to thread */}
                {!hasVoiceNote && (
                  <Pressable
                    onPress={handleAddThreadSegment}
                    disabled={!canAddThreadSegment}
                    hitSlop={8}
                    style={{ opacity: canAddThreadSegment ? 1 : 0.4 }}
                    accessibilityLabel="Add to thread"
                    accessibilityHint="Adds another cast below the current one"
                    accessibilityRole="button"
                    accessibilityState={{ disabled: !canAddThreadSegment }}
                  >
                    <Ionicons
                      name="add-circle-outline"
                      size={25}
                      color={colors.purple}
                    />
                  </Pressable>
                )}
              </View>
              <Text
                style={[
                  styles.charCount,
                  isActiveOverLimit && styles.charCountOver,
                ]}
              >
                {isThreadMode
                  ? `${activeSegmentIndex + 1}/${totalSegments} · ${byteCount}/${maxCastLength}`
                  : `${byteCount}/${maxCastLength}`}
              </Text>
            </View>
          </>
        )}
      </Animated.View>
      </KeyboardAvoidingView>
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
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
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
  bodyScroll: {
    flex: 1,
  },
  bodyScrollContent: {
    paddingBottom: 16,
  },
  composeArea: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingTop: 16,
    gap: 12,
  },
  avatarColumn: {
    alignItems: "center",
  },
  threadRail: {
    width: 2,
    flex: 1,
    marginTop: 8,
    borderRadius: 1,
    backgroundColor: colors.background.border,
  },
  inputArea: {
    flex: 1,
  },
  input: {
    // No explicit height: on Fabric a multiline TextInput auto-sizes to its
    // content when unconstrained; the body ScrollView owns scrolling.
    minHeight: COMPOSE_INPUT_MIN_HEIGHT,
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
  schedulePanel: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.background.border,
    backgroundColor: colors.background.surface,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
    gap: 12,
  },
  scheduleHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  scheduleTitleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  scheduleIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background.subtle,
  },
  scheduleHeadingGroup: {
    flex: 1,
    gap: 2,
  },
  scheduleTitle: {
    color: colors.text.primary,
    fontSize: 16,
    fontWeight: "700",
  },
  scheduleSubtitle: {
    color: colors.text.secondary,
    fontSize: 12,
  },
  scheduleClose: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  iosPickerRow: {
    minHeight: 44,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  androidPickerRow: {
    flexDirection: "row",
    gap: 10,
  },
  androidPickerButton: {
    flex: 1,
    minHeight: 54,
    justifyContent: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.background.border,
    backgroundColor: colors.background.main,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  androidPickerLabel: {
    color: colors.text.secondary,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  androidPickerValue: {
    color: colors.text.primary,
    fontSize: 16,
    fontWeight: "600",
    marginTop: 2,
  },
  scheduleStatus: {
    minHeight: 18,
    color: colors.text.secondary,
    fontSize: 13,
    lineHeight: 18,
  },
  scheduleStatusError: {
    color: colors.error,
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
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  scheduleToggle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  scheduleToggleActive: {
    backgroundColor: colors.accent,
  },
  scheduleTogglePressed: {
    opacity: 0.72,
  },
  scheduleToggleDisabled: {
    opacity: 0.4,
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
