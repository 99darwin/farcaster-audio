"use client";

/**
 * CastComposer — the shared composer core for casts, replies, and quotes on
 * `juke.audio/app`.
 *
 * This component is **fully controlled by props**: it owns no draft state of
 * its own (text + attachments live in the parent — the composeStore-backed
 * modal or the local-state inline box). It renders the textarea, character
 * counter, image upload UI, submit button, and inline errors, and owns only the
 * transient `submitting` flag.
 *
 * Two visual variants:
 *   - `modal`  — always-expanded, five-row textarea with a Cancel button;
 *                preserves the pre-extraction ComposeModal appearance.
 *   - `inline` — an avatar + single-row textarea that expands on focus / when
 *                non-empty, collapses on blur when empty, and has no Cancel.
 *
 * Power features wired in (B2):
 *   - @mention / /channel / :emoji autocomplete via `useComposerAutocomplete`
 *     + `SuggestionPopover`. /channel is suppressed in reply mode.
 *   - GIF picker via `GifPicker` modal (+ `kind:"gif"` ComposeAttachment).
 *   - OG link preview via `useOgPreview` + `OgPreviewCard`.
 *   - Draft autosave via `useDraftAutosave` (localStorage always; server for
 *     modal variant). Autosave covers the PRIMARY segment only — extra thread
 *     segments are transient local state and are lost on unmount/refresh.
 *
 * Threading (C1): the composer can hold extra segments beyond the controlled
 * primary draft. Like the voice note, they live in LOCAL state so the props
 * contract and composeStore stay untouched: the parent still owns segment 1's
 * `text`/`attachments`; segments 2..n live in `extraSegments`. One segment →
 * the existing `POST /v1/feed/cast` flow; 2+ → `POST /v1/feed/cast/thread`.
 * Voice notes and scheduling stay single-cast only (mutually exclusive with
 * threading).
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type RefObject,
} from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import { cn } from "@/components/ui/cn";
import { apiFetch, ApiFetchError } from "@/lib/api/client";
import { createCastThread } from "@/lib/api/cast-thread";
import {
  createScheduledCast,
  type ScheduledCast,
} from "@/lib/api/scheduled-casts";
import { uploadMedia, uploadVideo } from "@/lib/api/media";
import {
  uploadVoiceNote,
  pickRecorderMimeType,
  type RecordedVoiceNote,
} from "@/lib/api/voice-notes";
import { formatDuration } from "@/lib/voice-notes";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  buildCastPayload,
  buildThreadPayload,
  castMaxLength,
  counterColorClass,
  maxImageCount,
  newAttachmentId,
  utf8ByteLength,
  THREAD_MAX_SEGMENTS,
  type ThreadCreateRequest,
} from "@/lib/compose/composer-utils";
import {
  MEDIA_INPUT_ACCEPT,
  planMediaSelection,
} from "@/lib/compose/media-files";
import {
  defaultScheduleValue,
  formatScheduleConfirmation,
  toLocalDateTimeInput,
  validateLocalSchedule,
} from "@/lib/compose/scheduling";
import type {
  ComposeAttachment,
  ComposeMode,
  ComposeTarget,
} from "@/lib/stores/composeStore";
import type { GifResult } from "@/lib/api/gifs";
import { useComposerAutocomplete } from "./useComposerAutocomplete";
import { SuggestionPopover, rowInserted } from "./SuggestionPopover";
import { GifPicker } from "./GifPicker";
import { useOgPreview, OgPreviewCard } from "./OgPreviewCard";
import { useDraftAutosave } from "./useDraftAutosave";
import { VoiceRecorder } from "./VoiceRecorder";
import { AttachmentChips } from "./AttachmentChips";
import { ThreadSegmentEditor } from "./ThreadSegmentEditor";
import {
  useAutoGrowTextarea,
  INLINE_TEXTAREA_MAX_VIEWPORT_FRACTION,
  MODAL_TEXTAREA_MAX_VIEWPORT_FRACTION,
} from "./useAutoGrowTextarea";

/** A finalized recording held locally by the composer, plus its preview URL. */
interface AttachedVoiceNote {
  recording: RecordedVoiceNote;
  /** Object URL for the chip's preview `<audio>`; revoked on discard/unmount. */
  previewUrl: string;
}

/**
 * Sentinel id for the parent-controlled first segment (`text`/`attachments`
 * props). Extra segments get real `newAttachmentId()` ids.
 */
const PRIMARY_SEGMENT_ID = "primary";

/** One extra thread segment (segments 2..n), held in composer-local state. */
interface ThreadSegment {
  id: string;
  text: string;
  attachments: ComposeAttachment[];
}

/** Remote URLs of successfully uploaded attachments, in display order. */
function uploadedEmbedUrls(
  attachments: readonly ComposeAttachment[],
): string[] {
  return attachments
    .filter((a) => a.status === "uploaded" && a.url)
    .map((a) => a.url as string);
}

interface CastCreateResponse {
  cast?: { hash: string };
  hash?: string;
}

/** Details handed back to the parent after a successful publish. */
export interface PublishResult {
  /** The created cast hash, or `null` when the API omits it. */
  hash: string | null;
  /** The (trimmed) text that was published. */
  text: string;
  /** The uploaded embed URLs that were attached. */
  embeds: string[];
  mode: ComposeMode;
  /**
   * Number of casts published in this action (1 for a single cast, 2+ for a
   * thread). `hash`/`text`/`embeds` describe the FIRST cast either way.
   */
  segmentCount?: number;
  /**
   * True when this publish completed the tail of a partially published
   * thread (so hosts can phrase the confirmation as a thread).
   */
  continuedThread?: boolean;
}

/** Details handed back after a cast is safely queued (never feed-inserted). */
export interface ScheduleResult {
  job: ScheduledCast;
  scheduledFor: Date;
  confirmation: string;
}

export interface CastComposerProps {
  mode: ComposeMode;
  target?: ComposeTarget | null;
  text: string;
  onTextChange: (text: string) => void;
  attachments: ComposeAttachment[];
  /** Replace the attachment list. The composer revokes removed object URLs. */
  onAttachmentsChange: (attachments: ComposeAttachment[]) => void;
  /** Called after a successful `POST /v1/feed/cast`; parent clears/prepends. */
  onPublished?: (result: PublishResult) => void;
  /** Called after a successful schedule; parent clears without feed insertion. */
  onScheduled?: (result: ScheduleResult) => void;
  variant: "modal" | "inline";
  autoFocus?: boolean;
  placeholder?: string;
  /** Guards async setState after the surface closed/unmounted. */
  isCancelled?: () => boolean;
  /** Modal-only Cancel button; omit to hide (inline variant). */
  onCancel?: () => void;
  /** Mirrors the transient submitting flag so a parent can gate its close. */
  onSubmittingChange?: (submitting: boolean) => void;
  /** Extension point for autocomplete overlays; internal ref used otherwise. */
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
}

export function CastComposer({
  mode,
  target,
  text,
  onTextChange,
  attachments,
  onAttachmentsChange,
  onPublished,
  onScheduled,
  variant,
  autoFocus = false,
  placeholder,
  isCancelled,
  onCancel,
  onSubmittingChange,
  textareaRef: externalTextareaRef,
}: CastComposerProps) {
  const { status, user, signIn, isReadOnly, relink } = useAuth();
  const pathname = usePathname();

  const [submitting, setSubmitting] = useState(false);
  const [focused, setFocused] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleValue, setScheduleValue] = useState(() =>
    defaultScheduleValue(),
  );
  // Voice-note recording lives in local state (it never enters the
  // parent-controlled `attachments` list, keeping the props contract and
  // composeStore/ComposeAttachment types untouched).
  const [voiceSupported, setVoiceSupported] = useState(false);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const [voiceNote, setVoiceNote] = useState<AttachedVoiceNote | null>(null);
  // Thread segments beyond the parent-controlled primary draft. Local state,
  // same rationale as the voice note: the props contract stays single-cast.
  const [extraSegments, setExtraSegments] = useState<ThreadSegment[]>([]);
  // Which segment the shared media/GIF/drag-drop actions target.
  const [activeSegmentId, setActiveSegmentId] = useState(PRIMARY_SEGMENT_ID);
  // Set after a 207 partial thread publish: hash of the LAST successfully
  // published cast. The next submit chains the remaining tail after it instead
  // of re-applying the original reply/quote anchoring (which already went out
  // with the published prefix).
  //
  // Transient LOCAL state, like the extra segments: closing the surface after
  // a 207 keeps the tail text via draft autosave, but the anchor is lost, so
  // a later publish re-anchors to the original mode/target.
  const [continuationParent, setContinuationParent] = useState<string | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const mountedRef = useRef(true);
  // State updates are not synchronous; this closes the same-tick double-click
  // window for both immediate and scheduled submissions.
  const submitLockRef = useRef(false);
  const localObjectUrlsRef = useRef(new Set<string>());
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  /** Ref attached to the inline composer wrapper; used to detect focus-within
   *  so clicking action buttons doesn't collapse an empty composer. */
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;
  const textareaId = useId();
  const mediaHelpId = useId();
  const scheduleInputId = useId();
  const scheduleHelpId = useId();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const url of localObjectUrlsRef.current) {
        URL.revokeObjectURL(url);
      }
      localObjectUrlsRef.current.clear();
    };
  }, []);

  // React's input typings do not yet expose the native file-input `cancel`
  // event. Listen directly so dismissing the chooser releases the inline
  // composer's temporary expanded state in browsers that support it.
  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;
    const handlePickerCancel = () => setFilePickerOpen(false);
    input.addEventListener("cancel", handlePickerCancel);
    return () => input.removeEventListener("cancel", handlePickerCancel);
  }, []);

  // Keep the latest attachments readable inside async upload callbacks, since
  // the component is controlled and the closure would otherwise go stale.
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // ── Thread segment plumbing ───────────────────────────────────────────────
  // Every extra-segment write flows through `commitExtraSegments` so the ref
  // is ALWAYS current when read from async upload callbacks — the exact same
  // eager-ref pattern the primary segment uses with `attachmentsRef`.
  const extraSegmentsRef = useRef(extraSegments);
  const commitExtraSegments = useCallback((next: ThreadSegment[]) => {
    extraSegmentsRef.current = next;
    setExtraSegments(next);
  }, []);

  // Eager-set (same pattern as attachmentsRef/extraSegmentsRef) so ref
  // consumers can never observe a stale active segment within the same tick.
  const activeSegmentIdRef = useRef(activeSegmentId);
  const setActiveSegment = useCallback((id: string) => {
    activeSegmentIdRef.current = id;
    setActiveSegmentId(id);
  }, []);

  /** Active segment id, falling back to primary if that segment was removed. */
  const resolveActiveSegmentId = useCallback((): string => {
    const id = activeSegmentIdRef.current;
    if (id === PRIMARY_SEGMENT_ID) return id;
    return extraSegmentsRef.current.some((s) => s.id === id)
      ? id
      : PRIMARY_SEGMENT_ID;
  }, []);

  const readSegmentAttachments = useCallback(
    (segmentId: string): ComposeAttachment[] =>
      segmentId === PRIMARY_SEGMENT_ID
        ? attachmentsRef.current
        : (extraSegmentsRef.current.find((s) => s.id === segmentId)
            ?.attachments ?? []),
    [],
  );

  const writeSegmentAttachments = useCallback(
    (segmentId: string, next: ComposeAttachment[]) => {
      if (segmentId === PRIMARY_SEGMENT_ID) {
        attachmentsRef.current = next;
        onAttachmentsChange(next);
        return;
      }
      commitExtraSegments(
        extraSegmentsRef.current.map((s) =>
          s.id === segmentId ? { ...s, attachments: next } : s,
        ),
      );
    },
    [onAttachmentsChange, commitExtraSegments],
  );

  /**
   * Patch one attachment wherever it currently lives. Upload completions
   * route by ATTACHMENT id (not segment id) so they survive segment
   * removal/promotion while the upload is in flight.
   */
  const patchAttachment = useCallback(
    (attachmentId: string, patch: Partial<Omit<ComposeAttachment, "id">>) => {
      if (attachmentsRef.current.some((a) => a.id === attachmentId)) {
        writeSegmentAttachments(
          PRIMARY_SEGMENT_ID,
          attachmentsRef.current.map((a) =>
            a.id === attachmentId ? { ...a, ...patch } : a,
          ),
        );
        return;
      }
      const holder = extraSegmentsRef.current.find((s) =>
        s.attachments.some((a) => a.id === attachmentId),
      );
      if (!holder) return; // Segment removed mid-upload; result dropped.
      writeSegmentAttachments(
        holder.id,
        holder.attachments.map((a) =>
          a.id === attachmentId ? { ...a, ...patch } : a,
        ),
      );
    },
    [writeSegmentAttachments],
  );

  const revokeAttachmentPreviews = useCallback(
    (segmentAttachments: readonly ComposeAttachment[]) => {
      // revokeObjectURL is a no-op for non-blob URLs (e.g. Giphy previews).
      for (const attachment of segmentAttachments) {
        URL.revokeObjectURL(attachment.previewUrl);
        localObjectUrlsRef.current.delete(attachment.previewUrl);
      }
    },
    [],
  );

  useEffect(() => {
    onSubmittingChange?.(submitting);
  }, [submitting, onSubmittingChange]);

  // Voice recording requires MediaRecorder + a recordable mime type. Detect
  // after mount to avoid an SSR/client markup mismatch.
  useEffect(() => {
    const supported =
      typeof MediaRecorder !== "undefined" &&
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      pickRecorderMimeType((t) => MediaRecorder.isTypeSupported(t)) !== null;
    setVoiceSupported(supported);
  }, []);

  // Keep a ref so the unmount cleanup revokes the latest preview URL.
  const voiceNoteRef = useRef<AttachedVoiceNote | null>(null);
  useEffect(() => {
    voiceNoteRef.current = voiceNote;
  }, [voiceNote]);
  useEffect(
    () => () => {
      if (voiceNoteRef.current) {
        URL.revokeObjectURL(voiceNoteRef.current.previewUrl);
      }
    },
    [],
  );

  const handleVoiceComplete = useCallback((recording: RecordedVoiceNote) => {
    setVoiceNote((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return { recording, previewUrl: URL.createObjectURL(recording.blob) };
    });
    setRecorderOpen(false);
    setError(null);
  }, []);

  const handleVoiceDiscard = useCallback(() => {
    setVoiceNote((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
  }, []);

  const handleOpenRecorder = useCallback(() => {
    setError(null);
    setRecorderOpen(true);
  }, []);

  const maxLength = castMaxLength(Boolean(user?.is_pro));
  const maxImages = maxImageCount(Boolean(user?.is_pro));

  // All segments in thread order: the controlled primary draft + local extras.
  const allSegments: ThreadSegment[] = [
    { id: PRIMARY_SEGMENT_ID, text, attachments },
    ...extraSegments,
  ];
  const isThreaded = extraSegments.length > 0;
  const segmentCount = allSegments.length;
  const activeSegment =
    allSegments.find((s) => s.id === activeSegmentId) ?? allSegments[0];
  const activeAttachments = activeSegment.attachments;

  const remaining = maxLength - utf8ByteLength(text);
  const isUploading = allSegments.some((s) =>
    s.attachments.some((a) => a.status === "uploading"),
  );
  const hasUploadError = allSegments.some((s) =>
    s.attachments.some((a) => a.status === "error"),
  );
  const isOverLimit = allSegments.some((s) => utf8ByteLength(s.text) > maxLength);
  const hasVoiceNote = voiceNote !== null;
  const isEmpty =
    !isThreaded &&
    text.trim().length === 0 &&
    attachments.length === 0 &&
    !hasVoiceNote;

  const segmentHasContent = (segment: ThreadSegment): boolean =>
    segment.text.trim().length > 0 || segment.attachments.length > 0;
  const everySegmentHasContent = allSegments.every(segmentHasContent);
  const lastSegmentHasContent = segmentHasContent(
    allSegments[allSegments.length - 1],
  );

  const canSubmit =
    !submitting &&
    !isUploading &&
    !hasUploadError &&
    !isOverLimit &&
    !isEmpty &&
    !recorderOpen &&
    (!isThreaded || (everySegmentHasContent && !hasVoiceNote));

  const canAddSegment =
    !submitting && lastSegmentHasContent && segmentCount < THREAD_MAX_SEGMENTS;
  const scheduleValidation = scheduleOpen
    ? validateLocalSchedule(scheduleValue)
    : null;
  const scheduledEmbedCount =
    attachments.filter(
      (attachment) => attachment.status === "uploaded" && attachment.url,
    ).length + (mode === "quote" && target ? 1 : 0);
  const exceedsScheduledEmbedLimit = scheduledEmbedCount > 2;
  const canSchedule =
    canSubmit &&
    !hasVoiceNote &&
    !isThreaded &&
    continuationParent === null &&
    !exceedsScheduledEmbedLimit &&
    scheduleValidation?.ok === true;

  // Inline collapses to a single row until focused or non-empty; the modal is
  // always expanded. Also keep expanded while the GIF picker dialog is open or
  // while the recorder panel is mounted (focus leaves the textarea in both
  // cases, but the composer is still "active").
  const expanded =
    variant === "modal" ||
    focused ||
    !isEmpty ||
    isThreaded ||
    gifPickerOpen ||
    recorderOpen ||
    scheduleOpen ||
    filePickerOpen ||
    dragActive;

  // A fully cleared composer abandons any pending thread continuation —
  // otherwise brand-new content would silently chain under the old thread.
  useEffect(() => {
    if (isEmpty) setContinuationParent(null);
  }, [isEmpty]);

  // ── Autocomplete ──────────────────────────────────────────────────────────
  const autocomplete = useComposerAutocomplete({
    text,
    onTextChange,
    textareaRef,
    mode,
  });

  // ── Auto-grow ─────────────────────────────────────────────────────────────
  // #313 guard: resizing is driven by a post-commit effect on the controlled
  // `text` (see useAutoGrowTextarea) — never a native `input` listener.
  const textareaRows = variant === "modal" ? 5 : expanded ? 3 : 1;
  useAutoGrowTextarea(
    textareaRef,
    text,
    variant === "modal"
      ? MODAL_TEXTAREA_MAX_VIEWPORT_FRACTION
      : INLINE_TEXTAREA_MAX_VIEWPORT_FRACTION,
    textareaRows,
  );

  // ── OG preview ────────────────────────────────────────────────────────────
  const ogPreview = useOgPreview(text);

  // ── Draft autosave ────────────────────────────────────────────────────────
  const { clearDraft } = useDraftAutosave({
    mode,
    variant,
    text,
    onTextChange,
    target,
  });

  // ── File / image / video upload ───────────────────────────────────────────
  // Upload one file, tracking its lifecycle in the attachment list. The client
  // guards in uploadMedia/uploadVideo throw BEFORE any network call, so an
  // invalid file surfaces as an error chip without wasting an upload.
  const uploadAttachment = useCallback(
    async (file: File, kind: "image" | "video", segmentId: string) => {
      const id = newAttachmentId();
      const previewUrl = URL.createObjectURL(file);
      localObjectUrlsRef.current.add(previewUrl);
      const attachment: ComposeAttachment = {
        id,
        file,
        previewUrl,
        status: "uploading",
        kind,
      };
      writeSegmentAttachments(segmentId, [
        ...readSegmentAttachments(segmentId),
        attachment,
      ]);

      try {
        const url =
          kind === "video" ? await uploadVideo(file) : await uploadMedia(file);
        if (!mountedRef.current || isCancelled?.()) return;
        // Route by attachment id: the segment may have been promoted/removed
        // while the upload was in flight.
        patchAttachment(id, { status: "uploaded", url });
      } catch (err) {
        if (!mountedRef.current || isCancelled?.()) return;
        const message =
          err instanceof ApiFetchError
            ? err.detail || err.message || "Upload failed."
            : err instanceof Error
              ? err.message
              : "Upload failed.";
        patchAttachment(id, { status: "error", error: message });
        setError(message);
      }
    },
    [
      readSegmentAttachments,
      writeSegmentAttachments,
      patchAttachment,
      isCancelled,
    ],
  );

  const handleFiles = useCallback(
    async (fileList: FileList | readonly File[] | null) => {
      if (!fileList || fileList.length === 0) return;
      if (submitting) {
        setError("Wait for the current post to finish before adding media.");
        return;
      }
      if (hasVoiceNote || recorderOpen) {
        setError("Remove or finish the voice note before adding media.");
        return;
      }
      // Media targets the segment that was active when the files arrived.
      const segmentId = resolveActiveSegmentId();
      const plan = planMediaSelection(
        Array.from(fileList),
        readSegmentAttachments(segmentId),
        maxImages,
      );
      setError(plan.message);

      for (const item of plan.accepted) {
        await uploadAttachment(item.file, item.kind, segmentId);
      }
    },
    [
      hasVoiceNote,
      maxImages,
      recorderOpen,
      submitting,
      uploadAttachment,
      resolveActiveSegmentId,
      readSegmentAttachments,
    ],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      // Reset so re-selecting the same file re-triggers change.
      e.target.value = "";
      setFilePickerOpen(false);
      void handleFiles(files);
    },
    [handleFiles],
  );

  const handleOpenFilePicker = useCallback(() => {
    setFocused(true);
    setFilePickerOpen(true);
    fileInputRef.current?.click();
  }, []);

  const isFileDrag = useCallback(
    (dataTransfer: DataTransfer) =>
      Array.from(dataTransfer.types).includes("Files"),
    [],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setDragActive(true);
    },
    [isFileDrag],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [isFileDrag],
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    },
    [isFileDrag],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!isFileDrag(e.dataTransfer)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);

      // Ignore text/HTML drag payloads and directories. Only browser-provided
      // File objects are ever passed to the media validation/upload path.
      const itemFiles = Array.from(e.dataTransfer.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
      const files =
        itemFiles.length > 0 ? itemFiles : Array.from(e.dataTransfer.files);
      void handleFiles(files);
    },
    [handleFiles, isFileDrag],
  );

  const handleRemoveAttachment = useCallback(
    (id: string) => {
      const holderId = attachmentsRef.current.some((a) => a.id === id)
        ? PRIMARY_SEGMENT_ID
        : (extraSegmentsRef.current.find((s) =>
            s.attachments.some((a) => a.id === id),
          )?.id ?? null);
      if (holderId === null) return;

      const holderAttachments = readSegmentAttachments(holderId);
      const found = holderAttachments.find((a) => a.id === id);
      if (found) revokeAttachmentPreviews([found]);
      writeSegmentAttachments(
        holderId,
        holderAttachments.filter((a) => a.id !== id),
      );

      const anyErrorLeft =
        attachmentsRef.current.some((a) => a.status === "error") ||
        extraSegmentsRef.current.some((s) =>
          s.attachments.some((a) => a.status === "error"),
        );
      if (found?.status === "error" && !anyErrorLeft) {
        setError(null);
      }
    },
    [readSegmentAttachments, writeSegmentAttachments, revokeAttachmentPreviews],
  );

  // ── Thread segments ───────────────────────────────────────────────────────
  const handleAddSegment = useCallback(() => {
    const totalSegments = extraSegmentsRef.current.length + 1;
    if (totalSegments >= THREAD_MAX_SEGMENTS) return;
    const id = newAttachmentId();
    commitExtraSegments([
      ...extraSegmentsRef.current,
      { id, text: "", attachments: [] },
    ]);
    setActiveSegment(id);
  }, [commitExtraSegments, setActiveSegment]);

  const handleSegmentTextChange = useCallback(
    (segmentId: string, nextText: string) => {
      commitExtraSegments(
        extraSegmentsRef.current.map((s) =>
          s.id === segmentId ? { ...s, text: nextText } : s,
        ),
      );
    },
    [commitExtraSegments],
  );

  const handleRemoveSegment = useCallback(
    (segmentId: string) => {
      if (segmentId === PRIMARY_SEGMENT_ID) {
        // Removing the first segment promotes the next one into the
        // parent-controlled primary draft.
        const [promoted, ...rest] = extraSegmentsRef.current;
        if (!promoted) return;
        revokeAttachmentPreviews(attachmentsRef.current);
        // The removed primary text may have a persisted draft (localStorage +
        // debounced server copy). Clear it BEFORE swapping in the promoted
        // text so a stale server draft can't resurface on a later mount; the
        // autosave effect then re-persists the promoted text as needed.
        clearDraft();
        attachmentsRef.current = promoted.attachments;
        onAttachmentsChange(promoted.attachments);
        onTextChange(promoted.text);
        commitExtraSegments(rest);
      } else {
        const segment = extraSegmentsRef.current.find(
          (s) => s.id === segmentId,
        );
        if (!segment) return;
        revokeAttachmentPreviews(segment.attachments);
        commitExtraSegments(
          extraSegmentsRef.current.filter((s) => s.id !== segmentId),
        );
      }
      setActiveSegment(PRIMARY_SEGMENT_ID);
    },
    [
      clearDraft,
      commitExtraSegments,
      onAttachmentsChange,
      onTextChange,
      revokeAttachmentPreviews,
      setActiveSegment,
    ],
  );

  // ── GIF selection ─────────────────────────────────────────────────────────
  const handleGifSelect = useCallback(
    (gif: GifResult) => {
      // Defense-in-depth: ensure both URLs are safe absolute HTTPS URLs
      // (backend proxies Giphy, but a compromised backend could inject
      // javascript: or data: URIs which would be unsafe to render / embed).
      const safeHttps = (url: string) => /^https:\/\//i.test(url);
      if (!safeHttps(gif.gifUrl) || !safeHttps(gif.previewUrl)) {
        setError("Invalid GIF URL — please try another.");
        return;
      }

      const segmentId = resolveActiveSegmentId();
      const current = readSegmentAttachments(segmentId);
      const hasGif = current.some((a) => a.kind === "gif");

      const gifAttachment: ComposeAttachment = {
        id: newAttachmentId(),
        previewUrl: gif.previewUrl,
        status: "uploaded",
        url: gif.gifUrl,
        kind: "gif",
      };

      if (hasGif) {
        // Replace the existing GIF (max 1 GIF per segment).
        writeSegmentAttachments(segmentId, [
          ...current.filter((a) => a.kind !== "gif"),
          gifAttachment,
        ]);
      } else if (current.length < maxImages) {
        writeSegmentAttachments(segmentId, [...current, gifAttachment]);
      } else {
        setError(`You can attach up to ${maxImages} images.`);
      }
    },
    [
      maxImages,
      resolveActiveSegmentId,
      readSegmentAttachments,
      writeSegmentAttachments,
    ],
  );

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!canSubmit || submitLockRef.current) return;
    submitLockRef.current = true;
    setError(null);

    // Auth gate: route anonymous users to sign-in; do not attempt the post.
    if (status !== "authenticated") {
      try {
        await signIn();
      } catch {
        setError("You need to sign in to post.");
      } finally {
        submitLockRef.current = false;
      }
      return;
    }

    // Signer not approved (auth contract section 3): the post would 403, so
    // send the user to the re-link step instead.
    if (isReadOnly) {
      submitLockRef.current = false;
      await relink();
      return;
    }

    const trimmed = text.trim();

    // Voice-note publish is a DISTINCT flow: a voice note *is* the cast (its
    // embed is the note), so we run the three-step voice-note upload INSTEAD of
    // POST /v1/feed/cast — never both. Text becomes the caption/cast body.
    if (voiceNote) {
      const parentCastHash =
        mode === "reply" && target ? target.hash : undefined;
      setSubmitting(true);
      try {
        const published = await uploadVoiceNote({
          blob: voiceNote.recording.blob,
          durationMs: voiceNote.recording.durationMs,
          contentType: voiceNote.recording.contentType,
          castText: trimmed,
          postToFarcaster: true,
          parentCastHash,
        });
        clearDraft();
        if (isCancelled?.()) return;
        URL.revokeObjectURL(voiceNote.previewUrl);
        setVoiceNote(null);
        onPublished?.({
          hash: published.cast_hash ?? null,
          text: trimmed,
          embeds: [],
          mode,
        });
      } catch (err) {
        const message =
          err instanceof ApiFetchError
            ? err.detail || "Could not publish. Please try again."
            : err instanceof Error
              ? err.message
              : "Could not publish. Please try again.";
        setError(message);
      } finally {
        setSubmitting(false);
        submitLockRef.current = false;
      }
      return;
    }

    // ── Thread publish (2+ segments) ─────────────────────────────────────────
    // `POST /v1/feed/cast/thread` publishes the whole thread server-side with
    // guaranteed order. On a 207 partial failure the published prefix is
    // dropped from the composer and the unpublished tail is kept, so nothing
    // the user wrote is lost.
    if (extraSegmentsRef.current.length > 0) {
      const segmentsSnapshot: ThreadSegment[] = [
        { id: PRIMARY_SEGMENT_ID, text, attachments: attachmentsRef.current },
        ...extraSegmentsRef.current,
      ];
      const segmentDrafts = segmentsSnapshot.map((s) => ({
        text: s.text,
        embeds: uploadedEmbedUrls(s.attachments),
      }));
      // Resuming after a partial failure: the original reply/quote anchoring
      // already published with the first attempt's prefix, so the remaining
      // tail chains after the LAST published cast instead.
      const payload: ThreadCreateRequest = continuationParent
        ? {
            ...buildThreadPayload(segmentDrafts, "cast", null),
            parent: continuationParent,
          }
        : buildThreadPayload(segmentDrafts, mode, target);

      setSubmitting(true);
      try {
        const res = await createCastThread(payload);
        if (res.success) {
          // Same rationale as the single-cast flow: the casts are already on
          // the network, so consume the draft before the isCancelled guard.
          clearDraft();
          // Extra segments never reach the host, so their previews are
          // revoked here; the host revokes the primary's on its own reset.
          for (const segment of segmentsSnapshot.slice(1)) {
            revokeAttachmentPreviews(segment.attachments);
          }
          commitExtraSegments([]);
          setActiveSegment(PRIMARY_SEGMENT_ID);
          setContinuationParent(null);
          if (isCancelled?.()) return;
          onPublished?.({
            hash: res.casts[0]?.hash ?? null,
            text: segmentsSnapshot[0].text.trim(),
            embeds: payload.casts[0]?.embeds ?? [],
            mode,
            segmentCount: segmentsSnapshot.length,
            continuedThread: continuationParent !== null,
          });
        } else {
          // Clamp to the casts the server actually confirmed so the reslice
          // and the retry anchor stay consistent by construction, even if a
          // buggy backend reported failed_index > casts.length (an unclamped
          // slice would silently drop unpublished segments).
          const publishedCount = Math.min(
            res.failed_index ?? res.casts.length,
            res.casts.length,
          );
          // Anchor for the retry: the tail must chain after the last cast
          // that actually made it out.
          const lastPublishedHash =
            res.casts.length > 0
              ? (res.casts[res.casts.length - 1]?.hash ?? null)
              : null;
          const unpublished = segmentsSnapshot.slice(publishedCount);
          const [nextPrimary, ...nextExtras] = unpublished;
          if (publishedCount <= 0 || !nextPrimary || !lastPublishedHash) {
            // Nothing published, an inconsistent response, or no anchor to
            // chain a retry from: keep the composer exactly as it was.
            setError(
              res.error || "Could not publish the thread. Please try again.",
            );
          } else {
            // Drop the published prefix; keep every unpublished segment.
            for (const segment of segmentsSnapshot.slice(0, publishedCount)) {
              revokeAttachmentPreviews(segment.attachments);
            }
            attachmentsRef.current = nextPrimary.attachments;
            onAttachmentsChange(nextPrimary.attachments);
            onTextChange(nextPrimary.text);
            commitExtraSegments(nextExtras);
            setActiveSegment(PRIMARY_SEGMENT_ID);
            setContinuationParent(lastPublishedHash);
            setError(
              `Posted ${publishedCount} of ${segmentsSnapshot.length} casts — the rest failed. Your unposted casts are still in the composer; post again to continue the thread where it stopped.`,
            );
          }
        }
      } catch (err) {
        const message =
          err instanceof ApiFetchError
            ? err.detail || "Could not publish the thread. Please try again."
            : "Could not publish the thread. Please try again.";
        setError(message);
      } finally {
        setSubmitting(false);
        submitLockRef.current = false;
      }
      return;
    }

    const embeds = uploadedEmbedUrls(attachments);

    // A single remaining segment after a partial thread failure continues the
    // thread (chains after the last published cast) instead of re-anchoring to
    // the original reply/quote target as a disconnected cast.
    const payload = continuationParent
      ? { ...buildCastPayload(text, "cast", null, embeds), parent: continuationParent }
      : buildCastPayload(text, mode, target, embeds);

    setSubmitting(true);
    try {
      const res = await apiFetch<CastCreateResponse>("/v1/feed/cast", {
        method: "POST",
        body: payload,
      });
      // Clear draft unconditionally on publish success — the cast is already on
      // the network; the draft is consumed regardless of whether the surface is
      // still mounted.  This must run BEFORE the isCancelled guard so a
      // mid-flight modal close doesn't leave a stale localStorage/server draft.
      clearDraft();
      setContinuationParent(null);
      if (isCancelled?.()) return;
      onPublished?.({
        hash: res.cast?.hash ?? res.hash ?? null,
        text: trimmed,
        embeds,
        mode,
        continuedThread: continuationParent !== null,
      });
    } catch (err) {
      const message =
        err instanceof ApiFetchError
          ? err.detail || "Could not publish. Please try again."
          : "Could not publish. Please try again.";
      setError(message);
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }
  }, [
    canSubmit,
    status,
    signIn,
    isReadOnly,
    relink,
    attachments,
    text,
    mode,
    target,
    onPublished,
    onTextChange,
    onAttachmentsChange,
    isCancelled,
    clearDraft,
    voiceNote,
    continuationParent,
    commitExtraSegments,
    revokeAttachmentPreviews,
    setActiveSegment,
  ]);

  const handleSchedule = useCallback(async () => {
    if (!canSchedule || submitLockRef.current) {
      if (voiceNote) setError("Voice notes can’t be scheduled yet.");
      return;
    }

    // Revalidate at the exact click time; a panel left open can cross the
    // minimum boundary without causing a React render.
    const validation = validateLocalSchedule(scheduleValue);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    submitLockRef.current = true;
    setError(null);

    if (status !== "authenticated") {
      try {
        await signIn();
      } catch {
        setError("You need to sign in to schedule a post.");
      } finally {
        submitLockRef.current = false;
      }
      return;
    }

    if (isReadOnly) {
      submitLockRef.current = false;
      await relink();
      return;
    }

    const embeds = uploadedEmbedUrls(attachments);
    const payload = buildCastPayload(text, mode, target, embeds);

    // The protocol counts a quote toward the two-embed publishing cap. Give the
    // author a clear local error rather than queuing a job that cannot publish.
    if (payload.quote && embeds.length > 1) {
      setError("A scheduled quote can include one media attachment.");
      submitLockRef.current = false;
      return;
    }

    // A top-level composer opened while browsing a channel should preserve
    // that channel context. Strictly validate the decoded segment before it
    // ever reaches the API body.
    const channelMatch = /^\/app\/channel\/([^/]+)$/.exec(pathname);
    let channelId: string | undefined;
    if (mode === "cast" && channelMatch) {
      try {
        const decodedChannelId = decodeURIComponent(channelMatch[1]);
        if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(decodedChannelId)) {
          channelId = decodedChannelId;
        }
      } catch {
        // Malformed URL segment: omit channel context; never submit raw input.
      }
    }

    setSubmitting(true);
    try {
      const job = await createScheduledCast({
        ...payload,
        ...(channelId ? { channel_id: channelId } : {}),
        scheduled_for: validation.utcIso,
      });
      clearDraft();
      if (isCancelled?.()) return;
      setScheduleOpen(false);
      setScheduleValue(defaultScheduleValue());
      onScheduled?.({
        job,
        scheduledFor: validation.date,
        confirmation: formatScheduleConfirmation(validation.date),
      });
    } catch (err) {
      const message =
        err instanceof ApiFetchError
          ? err.detail || "Could not schedule this post. Please try again."
          : "Could not schedule this post. Please try again.";
      setError(message);
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }
  }, [
    attachments,
    canSchedule,
    clearDraft,
    isCancelled,
    mode,
    onScheduled,
    pathname,
    scheduleValue,
    signIn,
    isReadOnly,
    relink,
    status,
    target,
    text,
    voiceNote,
  ]);

  // ── Keyboard: Cmd+Enter / Ctrl+Enter submits the cast ─────────────────────
  // Intercepted before the autocomplete handler so Cmd+Enter always submits,
  // even when the suggestion popover is open. Plain Enter still accepts a
  // suggestion when autocomplete is active; Cmd/Ctrl+Enter bypasses that.
  const { handleKeyDown: handleAutocompleteKeyDown } = autocomplete;
  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        // Don't submit mid-IME-composition (e.g. selecting a CJK candidate).
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        void handleSubmit();
        return;
      }
      handleAutocompleteKeyDown(e);
    },
    [handleSubmit, handleAutocompleteKeyDown],
  );

  const resolvedPlaceholder =
    placeholder ?? (mode === "reply" ? "Post your reply…" : "What's happening?");

  const submitLabel =
    status !== "authenticated"
      ? "Sign in to post"
      : isReadOnly
        ? "Re-link to post"
        : continuationParent !== null
          ? "Continue thread"
          : isThreaded
            ? "Post thread"
            : mode === "reply"
              ? "Reply"
              : "Cast";

  // Media buttons act on the ACTIVE segment (embeds are per-cast). A video is
  // singular and mutually exclusive with images/GIFs within its segment
  // (mobile parity).
  const activeHasVideo = activeAttachments.some((a) => a.kind === "video");
  // GIF button disabled when a video is attached, or at the image cap (and no
  // existing GIF to replace).
  const activeHasGif = activeAttachments.some((a) => a.kind === "gif");
  const gifButtonDisabled =
    submitting ||
    activeHasVideo ||
    (!activeHasGif && activeAttachments.length >= maxImages);

  // Name the drop target while threaded so files don't land on the wrong cast.
  const activeSegmentPosition =
    allSegments.findIndex((s) => s.id === activeSegment.id) + 1;
  const dropOverlayLabel = isThreaded
    ? `Drop photos or one video to attach to cast ${activeSegmentPosition}`
    : "Drop photos or one video to attach";

  const scrollableContent = (
    <>
      {isThreaded && (
        <div className="mb-1 flex items-center justify-between">
          <span className="text-xs font-semibold text-juke-text-on-dark-secondary">
            Cast 1 of {segmentCount}
          </span>
          <button
            type="button"
            onClick={() => handleRemoveSegment(PRIMARY_SEGMENT_ID)}
            disabled={submitting}
            aria-label="Remove cast 1 from thread"
            className="flex h-6 w-6 items-center justify-center rounded-full bg-juke-navy/80 text-sm text-white hover:bg-juke-navy disabled:opacity-50"
          >
            ×
          </button>
        </div>
      )}

      <label htmlFor={textareaId} className="sr-only">
        {mode === "reply" ? "Reply" : mode === "quote" ? "Quote cast" : "New cast"}
      </label>

      {/* Relative container so SuggestionPopover can be absolute top-full. */}
      <div className="relative">
        <textarea
          id={textareaId}
          ref={textareaRef}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          onFocus={() => {
            setFocused(true);
            setActiveSegment(PRIMARY_SEGMENT_ID);
          }}
          onBlur={(e) => {
            // For the inline variant, keep the composer expanded when focus
            // moves to another element within the same composer container
            // (e.g. clicking the "Add image" or "GIF" button). Only collapse
            // when focus leaves the container entirely.
            if (
              variant === "inline" &&
              composerRef.current?.contains(e.relatedTarget as Node)
            ) {
              return;
            }
            setFocused(false);
          }}
          onKeyDown={handleTextareaKeyDown}
          placeholder={resolvedPlaceholder}
          rows={textareaRows}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- opt-in via prop; only used inside the modal/reply surfaces
          autoFocus={autoFocus}
          className={cn(
            "w-full resize-none bg-transparent text-juke-text-on-dark placeholder:text-juke-text-on-dark-secondary focus:outline-none",
            variant === "modal"
              ? "rounded-xl border border-juke-border bg-juke-navy/40 p-3 focus:border-juke-orange"
              : "px-1 py-1.5",
          )}
          aria-autocomplete="list"
          aria-describedby={mediaHelpId}
          aria-expanded={autocomplete.active !== null && autocomplete.results.length > 0}
        />

        {autocomplete.active !== null && autocomplete.results.length > 0 && (
          <SuggestionPopover
            rows={autocomplete.results}
            selectedIndex={autocomplete.selectedIndex}
            onHoverIndex={autocomplete.setSelectedIndex}
            onSelect={(row) => autocomplete.apply(rowInserted(row))}
            onDismiss={autocomplete.dismiss}
          />
        )}
      </div>

      <AttachmentChips
        attachments={attachments}
        onRemove={handleRemoveAttachment}
      />

      {/* Per-segment counter for cast 1 (the action-bar counter is hidden
          while threaded to avoid ambiguity about which segment it counts). */}
      {isThreaded && (
        <div
          aria-live="polite"
          aria-label={`${remaining} bytes remaining in cast 1`}
          className={cn(
            "mt-1 text-right text-xs tabular-nums",
            counterColorClass(remaining),
          )}
        >
          {remaining}
        </div>
      )}

      {/* Voice recorder panel — mounted while capturing. */}
      {recorderOpen && (
        <VoiceRecorder
          onComplete={handleVoiceComplete}
          onCancel={() => setRecorderOpen(false)}
        />
      )}

      {/* Recorded voice-note chip — distinct from image/GIF attachments. */}
      {voiceNote && (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-juke-border bg-juke-navy/40 p-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-juke-orange">
            Voice
          </span>
          <span className="text-sm tabular-nums text-juke-text-on-dark-secondary">
            {formatDuration(voiceNote.recording.durationMs)}
          </span>
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- user's own transient recording; no caption source */}
          <audio
            src={voiceNote.previewUrl}
            controls
            className="h-9 min-w-0 flex-1"
          />
          <button
            type="button"
            onClick={handleVoiceDiscard}
            disabled={submitting}
            aria-label="Discard voice note"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-juke-navy/80 text-sm text-white hover:bg-juke-navy disabled:opacity-50"
          >
            ×
          </button>
        </div>
      )}

      {/* OG link preview */}
      {ogPreview.metadata && (
        <OgPreviewCard
          metadata={ogPreview.metadata}
          onDismiss={ogPreview.dismiss}
        />
      )}

      {/* Thread segments 2..n — each owns its text + attachments. */}
      {extraSegments.map((segment, i) => (
        <ThreadSegmentEditor
          key={segment.id}
          index={i + 1}
          total={segmentCount}
          text={segment.text}
          onTextChange={(next) => handleSegmentTextChange(segment.id, next)}
          attachments={segment.attachments}
          onRemoveAttachment={handleRemoveAttachment}
          onRemoveSegment={() => handleRemoveSegment(segment.id)}
          onActivate={() => setActiveSegment(segment.id)}
          onSubmitShortcut={() => void handleSubmit()}
          isActive={activeSegmentId === segment.id}
          maxLength={maxLength}
          maxViewportFraction={
            variant === "modal"
              ? MODAL_TEXTAREA_MAX_VIEWPORT_FRACTION
              : INLINE_TEXTAREA_MAX_VIEWPORT_FRACTION
          }
          disabled={submitting}
        />
      ))}

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {error}
        </p>
      )}

      {scheduleOpen && (
        <section
          aria-label="Schedule post"
          className="mt-3 rounded-2xl border border-juke-orange/30 bg-juke-orange/10 p-3"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label
                htmlFor={scheduleInputId}
                className="mb-1.5 block text-xs font-semibold text-juke-text-on-dark"
              >
                Publish date and time
              </label>
              <input
                id={scheduleInputId}
                type="datetime-local"
                value={scheduleValue}
                min={toLocalDateTimeInput(new Date(Date.now() + 60_000))}
                max={toLocalDateTimeInput(
                  new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000),
                )}
                onChange={(event) => {
                  setScheduleValue(event.target.value);
                  setError(null);
                }}
                disabled={submitting}
                aria-describedby={scheduleHelpId}
                aria-invalid={scheduleValidation?.ok === false}
                className="h-10 w-full rounded-xl border border-juke-border bg-juke-navy px-3 text-sm text-juke-text-on-dark outline-none transition-colors focus:border-juke-orange disabled:opacity-50 [color-scheme:dark]"
              />
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSchedule()}
              loading={submitting}
              disabled={!canSchedule}
              className="shrink-0"
            >
              Schedule {mode === "reply" ? "reply" : "cast"}
            </Button>
          </div>
          <p
            id={scheduleHelpId}
            className={cn(
              "mt-2 text-xs",
              scheduleValidation?.ok === false || hasVoiceNote
                ? "text-red-300"
                : "text-juke-text-on-dark-secondary",
            )}
          >
            {hasVoiceNote
              ? "Voice notes can’t be scheduled yet."
              : isUploading
                ? "Finish uploading media before scheduling."
                : hasUploadError
                  ? "Remove failed media before scheduling."
                  : exceedsScheduledEmbedLimit
                    ? mode === "quote"
                      ? "A scheduled quote can include one media attachment."
                      : "Scheduled casts can include up to two media attachments."
                  : scheduleValidation?.ok
                    ? `Will publish ${formatScheduleConfirmation(scheduleValidation.date)}.`
                    : (scheduleValidation?.error ??
                      "Choose a time from 30 seconds to 365 days away.")}
          </p>
        </section>
      )}

      <p id={mediaHelpId} className="sr-only">
        Attach JPEG, PNG, GIF, WebP, MP4, MOV, or WebM files with the Add media
        button, or drag and drop them onto the composer.
      </p>

      <span className="sr-only" role="status" aria-live="polite">
        {dragActive ? "File drop active. Release to add media." : ""}
      </span>
    </>
  );

  const body = (
    <>
      {/* In the modal, everything above the action bar scrolls internally so
          the submit/action bar stays reachable however long the thread or
          attachment list grows (the panel is height-capped by ComposeModal). */}
      {variant === "modal" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">{scrollableContent}</div>
      ) : (
        scrollableContent
      )}

      {/* Persist outside the conditional action bar. Native picker focus can
          leave the document; unmounting this input before `change` is exactly
          what caused inline/header uploads to disappear. */}
      <input
        ref={fileInputRef}
        type="file"
        accept={MEDIA_INPUT_ACCEPT}
        multiple
        onChange={handleFileInputChange}
        className="hidden"
      />

      {/* Action bar — hidden while an empty inline box is collapsed. */}
      {expanded && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleOpenFilePicker}
              disabled={
                submitting ||
                activeHasVideo ||
                activeAttachments.length >= maxImages ||
                hasVoiceNote ||
                recorderOpen
              }
            >
              Add media
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setGifPickerOpen(true)}
              disabled={gifButtonDisabled || hasVoiceNote || recorderOpen}
              aria-label="Add GIF"
            >
              GIF
            </Button>
            {/* Voice notes are single-cast only — hidden while threaded or
                while a partially published thread is awaiting its retry. */}
            {voiceSupported && !isThreaded && continuationParent === null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleOpenRecorder}
                disabled={
                  submitting ||
                  attachments.length > 0 ||
                  hasVoiceNote ||
                  recorderOpen
                }
                aria-label="Record voice note"
              >
                Voice
              </Button>
            )}
            {/* Scheduling is single-cast only — hidden while threaded or
                while a partially published thread is awaiting its retry. */}
            {!isThreaded && continuationParent === null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFocused(true);
                  setScheduleOpen((open) => {
                    if (!open) setScheduleValue(defaultScheduleValue());
                    return !open;
                  });
                  setError(null);
                }}
                disabled={submitting}
                aria-expanded={scheduleOpen}
                aria-controls={scheduleInputId}
                leftIcon={
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    className="h-4 w-4"
                    aria-hidden
                  >
                    <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                }
              >
                Schedule
              </Button>
            )}
            {/* Threading is mutually exclusive with voice notes + schedules. */}
            {!hasVoiceNote && !recorderOpen && !scheduleOpen && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleAddSegment}
                disabled={!canAddSegment}
                aria-label="Add another cast to this thread"
                leftIcon={
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    className="h-4 w-4"
                    aria-hidden
                  >
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                }
              >
                Thread
              </Button>
            )}
            {!isThreaded && (
              <span
                aria-live="polite"
                aria-label={`${remaining} bytes remaining`}
                className={cn("text-xs tabular-nums", counterColorClass(remaining))}
              >
                {remaining}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {onCancel && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onCancel}
                disabled={submitting}
              >
                Cancel
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSubmit()}
              loading={submitting}
              disabled={!canSubmit}
            >
              {submitLabel}
            </Button>
          </div>
        </div>
      )}

      {/* GIF picker modal */}
      <GifPicker
        open={gifPickerOpen}
        onClose={() => setGifPickerOpen(false)}
        onSelect={handleGifSelect}
      />
    </>
  );

  if (variant === "inline") {
    return (
      <div className="flex gap-3">
        <Avatar
          src={user?.pfp_url}
          name={user?.display_name || user?.username || "You"}
          size="md"
        />
        {/* Container-level onBlur is the authoritative focus-within tracker.
            When any child (textarea or action button) loses focus to an element
            OUTSIDE this div (e.g., a page link after the GIF picker closes),
            setFocused(false) resets the expanded state. This is the safety net
            for the case where focus moves from an action button → GIF dialog →
            outside without ever re-triggering the textarea's own onBlur. The
            textarea's onBlur still guards against the flicker case where a
            focusable button has relatedTarget set (prevents early collapse). */}
        <div
          className={cn(
            "relative min-w-0 flex-1 rounded-xl transition-[background-color,box-shadow]",
            dragActive &&
              "bg-juke-orange/10 ring-2 ring-juke-orange ring-offset-2 ring-offset-juke-navy",
          )}
          ref={composerRef}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              setFocused(false);
            }
          }}
        >
          {dragActive && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-juke-orange bg-juke-navy/90 px-4 text-center text-sm font-semibold text-white">
              {dropOverlayLabel}
            </div>
          )}
          {body}
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        // flex + min-h-0 let the scrollable content region shrink inside the
        // height-capped modal panel while the action bar stays pinned.
        "relative flex min-h-0 flex-col rounded-xl transition-[background-color,box-shadow]",
        dragActive && "bg-juke-orange/10 ring-2 ring-juke-orange",
      )}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-juke-orange bg-juke-navy/90 px-4 text-center text-sm font-semibold text-white">
          {dropOverlayLabel}
        </div>
      )}
      {body}
    </div>
  );
}
