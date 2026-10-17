/**
 * Pure media-selection rules shared by the composer's file picker and drop
 * target. The backend still validates magic bytes; these checks provide fast,
 * consistent feedback before an upload starts.
 */

export const SUPPORTED_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

export const SUPPORTED_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
] as const;

export const MEDIA_INPUT_ACCEPT = [
  ...SUPPORTED_IMAGE_MIME_TYPES,
  ...SUPPORTED_VIDEO_MIME_TYPES,
].join(",");

const IMAGE_TYPES = new Set<string>(SUPPORTED_IMAGE_MIME_TYPES);
const VIDEO_TYPES = new Set<string>(SUPPORTED_VIDEO_MIME_TYPES);

export type UploadMediaKind = "image" | "video";

export interface MediaFileLike {
  name: string;
  type: string;
}

export interface ExistingAttachmentLike {
  kind?: "image" | "gif" | "video";
}

export interface PlannedMediaFile<T extends MediaFileLike> {
  file: T;
  kind: UploadMediaKind;
}

export interface MediaSelectionPlan<T extends MediaFileLike> {
  accepted: PlannedMediaFile<T>[];
  /** Feedback for ignored/rejected files. Accepted files may still be present. */
  message: string | null;
}

export function mediaKindForMime(type: string): UploadMediaKind | null {
  if (IMAGE_TYPES.has(type)) return "image";
  if (VIDEO_TYPES.has(type)) return "video";
  return null;
}

/**
 * Apply the composer attachment rules to a picker/drop selection.
 *
 * - one video, mutually exclusive with images and GIFs;
 * - images fill only the account's remaining image slots;
 * - unsupported MIME types are ignored with actionable feedback.
 */
export function planMediaSelection<T extends MediaFileLike>(
  files: readonly T[],
  currentAttachments: readonly ExistingAttachmentLike[],
  maxImages: number,
): MediaSelectionPlan<T> {
  if (files.length === 0) return { accepted: [], message: null };

  const supported = files.flatMap((file) => {
    const kind = mediaKindForMime(file.type);
    return kind ? [{ file, kind }] : [];
  });
  const unsupportedCount = files.length - supported.length;

  if (supported.length === 0) {
    return {
      accepted: [],
      message: "Unsupported file type. Choose a JPEG, PNG, GIF, WebP, MP4, MOV, or WebM file.",
    };
  }

  const video = supported.find((item) => item.kind === "video");
  if (video) {
    if (currentAttachments.length > 0) {
      return {
        accepted: [],
        message: "A video can't be combined with other attachments.",
      };
    }
    return {
      accepted: [video],
      message:
        supported.length > 1 || unsupportedCount > 0
          ? "Only one video can be attached. The other selected files weren't added."
          : null,
    };
  }

  if (currentAttachments.some((attachment) => attachment.kind === "video")) {
    return {
      accepted: [],
      message: "Remove the video before adding images.",
    };
  }

  const slotsLeft = Math.max(0, maxImages - currentAttachments.length);
  if (slotsLeft === 0) {
    return {
      accepted: [],
      message: `You can attach up to ${maxImages} images.`,
    };
  }

  const accepted = supported.slice(0, slotsLeft);
  const ignoredCount = supported.length - accepted.length + unsupportedCount;
  return {
    accepted,
    message:
      ignoredCount > 0
        ? `Added ${accepted.length} ${accepted.length === 1 ? "image" : "images"}; ${ignoredCount} ${ignoredCount === 1 ? "file was" : "files were"} not added because of type or attachment limits.`
        : null,
  };
}
