"use client";

/**
 * Cast embed rendering — the web port of the mobile app's embed decision tree
 * (`farcaster-audio/components/feed/CastCard.tsx` + `OgPreview.tsx`).
 *
 * The Hypersnap v2 read API returns `cast.embeds` as a mix of two record
 * shapes:
 *   - URL embeds:   `{ url, metadata }` — image, video, OG link, or mini-app frame
 *   - Quote embeds: `{ cast_id, cast }` — a full quoted cast
 *
 * Decision tree (matches mobile):
 *   1. Quote cast   → compact quoted-cast card → click opens that cast's thread
 *   2. Image        → grid of images → click opens a full-screen lightbox
 *   3. Video        → inline <video controls> (direct files); HLS (.m3u8) shows
 *                     a click-to-load poster (hls.js lazy-loaded on play). When
 *                     no OG poster exists, the video's first frame is rendered
 *                     as the preview instead of a black box.
 *   4. OG / frame   → link-preview card (image, title, host) + mini-app badge
 *   5. Plain link   → bare link chip (unchanged from the old behaviour)
 *
 * Every interactive element calls `stopPropagation` so it never triggers the
 * parent CastCard's whole-card thread navigation. All rendered URLs pass
 * through `safeImageUrl` / `safeLinkUrl` (https-only) before hitting the DOM.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/components/ui/cn";
import { Avatar } from "@/components/ui/avatar";
import { MiniAppBrowser } from "@/components/miniapp/MiniAppBrowser";
import { useMiniAppShell } from "@/components/miniapp/MiniAppShell";
import { safeImageUrl, safeLinkUrl } from "@/lib/safe-url";
import { parseFarcasterSpaceUrl } from "@/lib/spaces";
import { FarcasterSpaceEmbedCard } from "@/components/ui/farcaster-space-embed-card";
import { chooseHlsPlayback } from "@/lib/video/hls-playback";
import { parseTweetOembed, hasTweetContent } from "@/lib/embeds/oembed";
import {
  extractMiniAppLaunch,
  isMiniAppEmbed,
} from "@/lib/embeds/miniapp";
import type {
  EmbedMetadata,
  EmbeddedCast,
  UrlEmbed,
} from "@/lib/api/types";

// ---------------------------------------------------------------------------
// Narrowing helpers (embeds arrive as `unknown[]`)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A URL embed carries a string `url` and no inlined `cast`. */
function asUrlEmbed(value: unknown): UrlEmbed | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.cast)) return null;
  return typeof value.url === "string" ? (value as unknown as UrlEmbed) : null;
}

/** A quote embed carries an inlined `cast` with at least a hash + author. */
function asQuoteCast(value: unknown): EmbeddedCast | null {
  if (!isRecord(value)) return null;
  const cast = value.cast;
  if (!isRecord(cast)) return null;
  if (typeof cast.hash !== "string") return null;
  if (!isRecord(cast.author)) return null;
  return cast as unknown as EmbeddedCast;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m3u8)(\?|$)/i;
const HLS_EXT = /\.m3u8(\?|$)/i;

function metadataOf(embed: UrlEmbed): EmbedMetadata {
  return embed.metadata ?? {};
}

function isImageEmbed(embed: UrlEmbed): boolean {
  const meta = metadataOf(embed);
  if (meta.content_type?.startsWith("image/")) return true;
  // The read API populates image dimensions for image embeds even without content_type.
  if (meta.image?.width_px) return true;
  return IMAGE_EXT.test(embed.url);
}

function isVideoEmbed(embed: UrlEmbed): boolean {
  const meta = metadataOf(embed);
  if (meta.content_type?.startsWith("video/")) return true;
  return VIDEO_EXT.test(embed.url);
}

function frameMeta(embed: UrlEmbed): Record<string, unknown> | undefined {
  const meta = metadataOf(embed);
  return meta.fc_frame ?? meta.frame;
}

function getOgImage(embed: UrlEmbed): string | null {
  const frame = frameMeta(embed);
  const frameImage = frame?.image_url;
  if (typeof frameImage === "string") return safeImageUrl(frameImage);
  return safeImageUrl(metadataOf(embed).html?.ogImage?.[0]?.url);
}

function getOgTitle(embed: UrlEmbed): string | undefined {
  return metadataOf(embed).html?.ogTitle;
}

function getOgDescription(embed: UrlEmbed): string | undefined {
  return metadataOf(embed).html?.ogDescription;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** X blocks OG scraping, so the read API carries tweets via `metadata.html.oembed`. */
function isTwitterUrl(url: string): boolean {
  const domain = getDomain(url);
  return domain === "x.com" || domain === "twitter.com";
}

/** A tweet embed is an x.com/twitter.com URL with renderable oembed content. */
function isTweetEmbed(embed: UrlEmbed): boolean {
  if (!isTwitterUrl(embed.url)) return false;
  return hasTweetContent(parseTweetOembed(metadataOf(embed).html?.oembed));
}

function displayLink(url: string): string {
  try {
    const { hostname, pathname } = new URL(url);
    const host = hostname.replace(/^www\./, "");
    return pathname && pathname !== "/" ? `${host}${pathname}` : host;
  } catch {
    return url;
  }
}

/** An OG/link embed renders a preview card when it carries any OG/frame data. */
function hasOgPreview(embed: UrlEmbed): boolean {
  return !!(getOgImage(embed) || getOgTitle(embed) || getOgDescription(embed));
}

/** Collect the first safe image URL from a (quoted) cast's own embeds. */
function firstImageUrl(embeds: unknown[] | undefined): string | null {
  if (!Array.isArray(embeds)) return null;
  for (const raw of embeds) {
    const embed = asUrlEmbed(raw);
    if (embed && isImageEmbed(embed)) {
      const safe = safeImageUrl(embed.url);
      if (safe) return safe;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Classified embeds
// ---------------------------------------------------------------------------

interface SpaceEmbed {
  spaceId: string;
  /** Original embed, kept for the OG-card / link-chip fallback render. */
  embed: UrlEmbed;
}

interface ClassifiedEmbeds {
  images: string[];
  videos: UrlEmbed[];
  tweets: UrlEmbed[];
  spaces: SpaceEmbed[];
  ogCards: UrlEmbed[];
  links: string[];
  quote: EmbeddedCast | null;
}

function classifyEmbeds(embeds: unknown[] | undefined): ClassifiedEmbeds {
  const result: ClassifiedEmbeds = {
    images: [],
    videos: [],
    tweets: [],
    spaces: [],
    ogCards: [],
    links: [],
    quote: null,
  };
  if (!Array.isArray(embeds)) return result;

  for (const raw of embeds) {
    const quote = asQuoteCast(raw);
    if (quote) {
      // Only the first quote cast is rendered (mobile parity).
      if (!result.quote) result.quote = quote;
      continue;
    }

    const embed = asUrlEmbed(raw);
    if (!embed) continue;

    // Farcaster-native audio spaces must be checked before the mini-app / OG
    // branches — farcaster.xyz URLs often carry frame metadata and would
    // otherwise be misrouted to a generic card (mobile renders these as rich
    // space cards via `OgPreview` → `FarcasterSpaceEmbedCard`).
    const space = parseFarcasterSpaceUrl(embed.url);
    if (space) {
      result.spaces.push({ spaceId: space.id, embed });
      continue;
    }

    if (isImageEmbed(embed)) {
      const safe = safeImageUrl(embed.url);
      if (safe && result.images.length < 4) result.images.push(safe);
      continue;
    }

    if (isVideoEmbed(embed)) {
      if (safeLinkUrl(embed.url)) result.videos.push(embed);
      continue;
    }

    // Tweets carry oembed content (X blocks OG scraping). Falls through to the
    // OG card / plain link below when no usable oembed data is present.
    if (isTweetEmbed(embed)) {
      if (safeLinkUrl(embed.url)) result.tweets.push(embed);
      continue;
    }

    if (isMiniAppEmbed(embed)) {
      if (extractMiniAppLaunch(embed) || safeLinkUrl(embed.url)) {
        result.ogCards.push(embed);
      }
      continue;
    }

    if (hasOgPreview(embed)) {
      if (safeLinkUrl(embed.url)) result.ogCards.push(embed);
      continue;
    }

    // Plain link with no metadata — bare chip, https-only.
    const safe = safeLinkUrl(embed.url);
    if (safe) result.links.push(safe);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function CastEmbeds({ embeds }: { embeds: unknown[] | undefined }) {
  const { images, videos, tweets, spaces, ogCards, links, quote } = useMemo(
    () => classifyEmbeds(embeds),
    [embeds],
  );

  const hasContent =
    images.length > 0 ||
    videos.length > 0 ||
    tweets.length > 0 ||
    spaces.length > 0 ||
    ogCards.length > 0 ||
    links.length > 0 ||
    quote !== null;
  if (!hasContent) return null;

  return (
    <>
      {images.length > 0 && <ImageGrid images={images} />}
      {videos.map((embed) => (
        <VideoEmbed key={embed.url} embed={embed} />
      ))}
      {tweets.map((embed) => (
        <TweetEmbed key={embed.url} embed={embed} />
      ))}
      {spaces.map(({ spaceId, embed }) => (
        <SpaceEmbedWithFallback key={spaceId} spaceId={spaceId} embed={embed} />
      ))}
      {ogCards.map((embed) => (
        <OgEmbedCard key={embed.url} embed={embed} />
      ))}
      {links.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {links.map((url) => (
            <LinkChip key={url} url={url} />
          ))}
        </div>
      )}
      {quote && <QuotedCast cast={quote} />}
    </>
  );
}

/** Bare https-only link chip — the lowest-fidelity embed render. */
function LinkChip({ url }: { url: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(event) => event.stopPropagation()}
      className="block truncate rounded-lg border border-juke-border px-3 py-2 text-xs text-juke-text-on-dark-secondary transition-colors hover:border-white/25 hover:bg-white/5"
    >
      {displayLink(url)}
    </a>
  );
}

/**
 * Farcaster-native space embed with graceful degradation (mobile parity):
 * render the rich space card; when the room snapshot can't be resolved
 * (deleted space, proxy 503, network) fall back to the embed's OG card or,
 * failing that, a bare link chip.
 */
function SpaceEmbedWithFallback({
  spaceId,
  embed,
}: {
  spaceId: string;
  embed: UrlEmbed;
}) {
  const [fallback, setFallback] = useState(false);

  if (!fallback) {
    return (
      <FarcasterSpaceEmbedCard
        spaceId={spaceId}
        onFallback={() => setFallback(true)}
      />
    );
  }

  if (hasOgPreview(embed) && safeLinkUrl(embed.url)) {
    return <OgEmbedCard embed={embed} />;
  }

  const safe = safeLinkUrl(embed.url);
  if (!safe) return null;
  return (
    <div className="mt-2">
      <LinkChip url={safe} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Images + lightbox (Bug B)
// ---------------------------------------------------------------------------

function ImageGrid({ images }: { images: string[] }) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <>
      <div
        className={cn(
          "mt-2 grid gap-1.5 overflow-hidden rounded-xl",
          images.length > 1 ? "grid-cols-2" : "grid-cols-1",
        )}
      >
        {images.map((url, index) => (
          <button
            key={url}
            type="button"
            aria-label="View image"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setLightboxIndex(index);
            }}
            className="group/img block overflow-hidden rounded-xl border border-juke-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/60"
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- remote embed hosts vary; next/image remote allow-list is out of scope */}
            <img
              src={url}
              alt=""
              referrerPolicy="no-referrer"
              loading="lazy"
              className="max-h-96 w-full cursor-zoom-in object-cover transition-transform group-hover/img:scale-[1.01]"
            />
          </button>
        ))}
      </div>
      {lightboxIndex !== null && (
        <ImageLightbox
          images={images}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}

/**
 * Full-screen image overlay: dark backdrop, image contained at natural size,
 * closes on Escape or backdrop click. Portals to `document.body` so it escapes
 * any ancestor stacking context (matches the shared Modal's strategy).
 */
function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  images: string[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const hasMultiple = images.length > 1;
  const goPrev = useCallback(
    () => onIndexChange((index - 1 + images.length) % images.length),
    [index, images.length, onIndexChange],
  );
  const goNext = useCallback(
    () => onIndexChange((index + 1) % images.length),
    [index, images.length, onIndexChange],
  );

  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      } else if (hasMultiple && event.key === "ArrowLeft") {
        goPrev();
      } else if (hasMultiple && event.key === "ArrowRight") {
        goNext();
      }
    }
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = original;
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose, goPrev, goNext, hasMultiple]);

  if (!mounted) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      onClick={(event) => {
        // Backdrop click closes; clicks on the image itself do not.
        if (event.target === event.currentTarget) onClose();
        event.stopPropagation();
      }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4"
    >
      <button
        type="button"
        aria-label="Close image viewer"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
          <path d="M18 6 6 18M6 6l12 12" />
        </svg>
      </button>

      {hasMultiple && (
        <button
          type="button"
          aria-label="Previous image"
          onClick={(event) => {
            event.stopPropagation();
            goPrev();
          }}
          className="absolute left-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      )}

      {/* eslint-disable-next-line @next/next/no-img-element -- remote embed hosts vary */}
      <img
        src={images[index]}
        alt=""
        referrerPolicy="no-referrer"
        className="max-h-full max-w-full object-contain"
        onClick={(event) => event.stopPropagation()}
      />

      {hasMultiple && (
        <button
          type="button"
          aria-label="Next image"
          onClick={(event) => {
            event.stopPropagation();
            goNext();
          }}
          className="absolute right-4 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
        >
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      )}
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Video (Bug A)
// ---------------------------------------------------------------------------

/** Tiny seek offset that forces browsers to paint frame one while paused. */
const FIRST_FRAME_SEEK_OFFSET_S = 0.001;

/** Preview buffering budget for posterless HLS first-frame rendering. */
const HLS_PREVIEW_MAX_BUFFER_S = 2;

/**
 * Opening GOPs commonly begin with a few black frames. Let a muted preview
 * advance briefly before freezing so the still is representative content.
 */
const HLS_PREVIEW_CAPTURE_OFFSET_S = 0.45;

/** Seek a hair past t=0 (only from a cold start) so the first frame paints. */
function nudgeToFirstFrame(video: HTMLVideoElement) {
  if (video.currentTime === 0) video.currentTime = FIRST_FRAME_SEEK_OFFSET_S;
}

/**
 * Direct video files (mp4/webm/mov) render inline with native controls. HLS
 * streams (.m3u8) — which is most Farcaster video — play inline too via a
 * click-to-load poster: hls.js is lazily pulled in on the first play intent
 * (never N players preloading in the feed), with native HLS as the fallback
 * for MSE-less browsers. If neither can attach, it degrades to a poster card
 * that links out.
 */
function VideoEmbed({ embed }: { embed: UrlEmbed }) {
  const url = safeLinkUrl(embed.url);
  if (!url) return null;

  const poster = getOgImage(embed) ?? undefined;

  if (HLS_EXT.test(embed.url)) {
    return <HlsVideoEmbed url={url} poster={poster} />;
  }
  return (
    <DirectVideoEmbed
      url={url}
      poster={poster}
      contentType={metadataOf(embed).content_type}
    />
  );
}

/**
 * Direct videos use the same click-to-load model as HLS. The near-viewport
 * preview decodes one frame; the full controls/player only mounts after an
 * explicit play intent, avoiding dozens of competing media downloads.
 */
function DirectVideoEmbed({
  url,
  poster,
  contentType,
}: {
  url: string;
  poster?: string;
  contentType?: string;
}) {
  const [active, setActive] = useState(false);

  if (!active) {
    return (
      <VideoPosterLink
        url={url}
        poster={poster}
        previewKind="direct"
        onActivate={() => setActive(true)}
      />
    );
  }

  return (
    <video
      controls
      playsInline
      autoPlay
      preload="metadata"
      poster={poster}
      onClick={(event) => event.stopPropagation()}
      className="mt-2 max-h-96 w-full rounded-xl border border-juke-border bg-black"
    >
      <source src={url} type={contentType || undefined} />
    </video>
  );
}

function DirectFirstFrame({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  const previewUrl = url.includes("#")
    ? url
    : `${url}#t=${FIRST_FRAME_SEEK_OFFSET_S}`;

  return (
    <video
      ref={videoRef}
      src={visible ? previewUrl : undefined}
      muted
      playsInline
      preload={visible ? "auto" : "none"}
      aria-hidden
      tabIndex={-1}
      onLoadedMetadata={(event) => nudgeToFirstFrame(event.currentTarget)}
      onLoadedData={() => setReady(true)}
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-200",
        ready ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/**
 * HLS player with a click-to-load poster. Nothing is fetched until the viewer
 * taps play. hls.js (MSE) is always preferred when supported — Chromium's
 * built-in HLS player answers `canPlayType` with "maybe" but can't play
 * stream.farcaster.xyz's redirected manifests (see `chooseHlsPlayback`) —
 * and native `<video src>` is the fallback for MSE-less browsers (iOS
 * Safari). On a fatal error we flip to `failed` and render the link-out
 * poster so the video is never a dead end.
 */
function HlsVideoEmbed({ url, poster }: { url: string; poster?: string }) {
  const [active, setActive] = useState(false);
  const [failed, setFailed] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    // Keep a handle to whatever we create so cleanup can tear it down even if
    // the dynamic import resolves after unmount.
    let instance: { destroy: () => void } | null = null;
    let nativeSrcSet = false;

    const canPlayNativeHls = () =>
      video.canPlayType("application/vnd.apple.mpegurl") !== "";

    const playNatively = () => {
      nativeSrcSet = true;
      video.src = url;
      void video.play().catch(() => {});
    };

    import("hls.js")
      .then(({ default: Hls }) => {
        if (cancelled || !videoRef.current) return;
        const strategy = chooseHlsPlayback({
          mseSupported: Hls.isSupported(),
          canPlayNativeHls: canPlayNativeHls(),
        });
        if (strategy === "native") {
          playNatively();
          return;
        }
        if (strategy === "unsupported") {
          setFailed(true);
          return;
        }
        const hls = new Hls({ enableWorker: true });
        instance = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            hls.destroy();
            instance = null;
            setFailed(true);
          }
        });
        // `play()` before hls.js has parsed a manifest is rejected by Chromium
        // and is not retried. Attach first, load once MediaSource is ready, and
        // honor the original click after the manifest becomes playable.
        hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!cancelled) void video.play().catch(() => {});
        });
        hls.attachMedia(video);
      })
      .catch(() => {
        // hls.js failed to load — native HLS is the only remaining option.
        if (cancelled || !videoRef.current) return;
        if (canPlayNativeHls()) playNatively();
        else setFailed(true);
      });

    return () => {
      cancelled = true;
      instance?.destroy();
      if (nativeSrcSet) {
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [active, url]);

  // Fatal HLS failure → link out rather than leaving a stuck player.
  if (failed) {
    return <VideoPosterLink url={url} poster={poster} linkOut />;
  }

  if (!active) {
    return (
      <VideoPosterLink
        url={url}
        poster={poster}
        onActivate={() => setActive(true)}
      />
    );
  }

  return (
    <video
      ref={videoRef}
      controls
      playsInline
      autoPlay
      preload="none"
      poster={poster}
      onClick={(event) => event.stopPropagation()}
      className="mt-2 max-h-96 w-full rounded-xl border border-juke-border bg-black"
    />
  );
}

/**
 * First-frame preview for HLS streams that carry no OG poster. Renders an
 * inert, muted <video> that buffers just enough to paint frame one, then
 * halts all loading. Lazy-inits via IntersectionObserver so a feed full of
 * posterless videos never fetches media for off-screen previews. Best-effort:
 * on any failure it stays black and the play affordance still works.
 */
function HlsFirstFrame({ url }: { url: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [ready, setReady] = useState(false);

  // Defer any network activity until the embed scrolls near the viewport.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "100px" },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    let instance: { destroy: () => void; stopLoad: () => void } | null = null;
    let nativeSrcSet = false;
    let previewStartedAt: number | null = null;
    const paintFirstFrame = () => nudgeToFirstFrame(video);
    const markReady = () => {
      if (cancelled) return;
      setReady(true);
      // Pause only after a decodable frame exists, then end the preview's
      // network budget. Muted play below makes Chromium actually paint it.
      const finish = () => {
        video.pause();
        instance?.stopLoad();
      };
      if ("requestVideoFrameCallback" in video) {
        video.requestVideoFrameCallback(() => finish());
      } else {
        window.requestAnimationFrame(finish);
      }
    };
    const startPreviewPlayback = () => {
      if (cancelled || previewStartedAt !== null) return;
      previewStartedAt = video.currentTime;
      void video.play().catch(() => {});
    };
    const captureUsefulFrame = () => {
      if (
        previewStartedAt !== null &&
        video.currentTime - previewStartedAt >= HLS_PREVIEW_CAPTURE_OFFSET_S
      ) {
        markReady();
      }
    };
    video.addEventListener("loadedmetadata", paintFirstFrame);
    video.addEventListener("loadeddata", startPreviewPlayback);
    video.addEventListener("timeupdate", captureUsefulFrame);

    const canPlayNativeHls = () =>
      video.canPlayType("application/vnd.apple.mpegurl") !== "";

    // MSE-less browsers (iOS Safari): native HLS under preload="metadata"
    // stays light — the loadedmetadata seek pulls in just the first frame.
    const previewNatively = () => {
      nativeSrcSet = true;
      video.src = url;
    };

    // Same strategy order as HlsVideoEmbed: hls.js when MSE exists, native
    // only as a fallback (Chromium's "maybe" from canPlayType is a lie for
    // this CDN — see `chooseHlsPlayback`).
    import("hls.js")
      .then(({ default: Hls }) => {
        if (cancelled || !videoRef.current) return;
        const strategy = chooseHlsPlayback({
          mseSupported: Hls.isSupported(),
          canPlayNativeHls: canPlayNativeHls(),
        });
        if (strategy === "native") {
          previewNatively();
          return;
        }
        if (strategy === "unsupported") {
          // Preview is best-effort; the play affordance still works.
          return;
        }
        const hls = new Hls({
          // Preview-only budget: lowest rendition (hls.js sorts levels by
          // ascending bitrate) and a ~2s buffer cap until stopLoad() fires.
          startLevel: 0,
          maxBufferLength: HLS_PREVIEW_MAX_BUFFER_S,
          maxMaxBufferLength: HLS_PREVIEW_MAX_BUFFER_S,
        });
        instance = hls;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            hls.destroy();
            instance = null;
          }
        });
        hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!cancelled && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
            startPreviewPlayback();
          }
        });
        hls.attachMedia(video);
      })
      .catch(() => {
        // hls.js failed to load; a native-capable browser can still preview.
        if (!cancelled && videoRef.current && canPlayNativeHls()) {
          previewNatively();
        }
      });

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", paintFirstFrame);
      video.removeEventListener("loadeddata", startPreviewPlayback);
      video.removeEventListener("timeupdate", captureUsefulFrame);
      instance?.destroy();
      if (nativeSrcSet) {
        video.removeAttribute("src");
        video.load();
      }
    };
  }, [visible, url]);

  return (
    <video
      ref={videoRef}
      muted
      playsInline
      preload="metadata"
      aria-hidden
      tabIndex={-1}
      className={cn(
        "pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-200",
        ready ? "opacity-100" : "opacity-0",
      )}
    />
  );
}

/**
 * Poster with a centered play glyph. Either activates inline playback
 * (`onActivate`) or, when `linkOut` is set, opens the stream in a new tab.
 * Without OG poster metadata it renders the stream's first frame instead of
 * a black box (skipped on `linkOut`, which only follows a fatal HLS error —
 * no point re-attaching a player to a stream that just failed).
 */
function VideoPosterLink({
  url,
  poster,
  onActivate,
  linkOut,
  previewKind = "hls",
}: {
  url: string;
  poster?: string;
  onActivate?: () => void;
  linkOut?: boolean;
  previewKind?: "direct" | "hls";
}) {
  const inner = (
    <>
      <span
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_25%_15%,rgba(216,90,48,0.28),transparent_42%),linear-gradient(135deg,#1a1a2e,#0f0f23)]"
      />
      {poster ? (
        // eslint-disable-next-line @next/next/no-img-element -- remote embed hosts vary
        <img
          src={poster}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        !linkOut &&
        (previewKind === "direct" ? (
          <DirectFirstFrame url={url} />
        ) : (
          <HlsFirstFrame url={url} />
        ))
      )}
      {!poster && (
        <span className="absolute bottom-3 left-3 rounded-full bg-black/55 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/80 backdrop-blur-sm">
          Video
        </span>
      )}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/60 transition-colors group-hover:bg-black/80">
          <svg width={28} height={28} viewBox="0 0 24 24" fill="currentColor" className="ml-0.5 text-white" aria-hidden>
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
      </span>
    </>
  );

  const className =
    "group relative mt-2 block aspect-video w-full overflow-hidden rounded-xl border border-juke-border bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/60";

  if (linkOut) {
    return (
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer nofollow"
        onClick={(event) => event.stopPropagation()}
        aria-label="Play video (opens in a new tab)"
        className={className}
      >
        {inner}
      </a>
    );
  }

  return (
    <button
      type="button"
      aria-label="Play video"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate?.();
      }}
      className={className}
    >
      {inner}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Tweet / X embed — mobile parity for `OgPreview`'s Twitter branch
// ---------------------------------------------------------------------------

/**
 * X/Twitter card built from the read API's oembed data. The tweet body and author
 * are parsed to PLAIN STRINGS in `lib/embeds/oembed.ts` (all markup stripped)
 * and rendered as escaped JSX text — no `dangerouslySetInnerHTML`, no
 * widgets.js. The whole card links to the tweet (https-only via `safeLinkUrl`).
 */
function TweetEmbed({ embed }: { embed: UrlEmbed }) {
  const url = safeLinkUrl(embed.url);
  if (!url) return null;

  const { author, handle, text } = parseTweetOembed(
    metadataOf(embed).html?.oembed,
  );

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={(event) => event.stopPropagation()}
      className="mt-2 block overflow-hidden rounded-xl border border-juke-border bg-juke-navy/40 p-3 transition-colors hover:border-white/25"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-1.5">
          {author && (
            <span className="truncate text-sm font-semibold text-juke-text-on-dark">
              {author}
            </span>
          )}
          {handle && (
            <span className="truncate text-xs text-juke-text-on-dark-secondary">
              @{handle}
            </span>
          )}
        </div>
        <span
          aria-hidden
          className="shrink-0 text-lg font-bold leading-none text-juke-text-on-dark"
        >
          𝕏
        </span>
      </div>
      {text && (
        <p className="mt-2 line-clamp-6 whitespace-pre-wrap break-words text-sm text-juke-text-on-dark">
          {text}
        </p>
      )}
      <p className="mt-2 text-xs text-juke-text-on-dark-secondary">View on X</p>
    </a>
  );
}

// ---------------------------------------------------------------------------
// OG / link preview card (Bug A) — mirrors composer OgPreviewCard's language
// ---------------------------------------------------------------------------

function OgEmbedCard({ embed }: { embed: UrlEmbed }) {
  const [miniAppOpen, setMiniAppOpen] = useState(false);
  const miniAppShell = useMiniAppShell();
  const miniApp = isMiniAppEmbed(embed);
  const launch = extractMiniAppLaunch(embed);
  const url = launch?.launchUrl ?? safeLinkUrl(embed.url);
  if (!url) return null;
  const image = getOgImage(embed);
  const title = launch?.title ?? getOgTitle(embed);
  const description = getOgDescription(embed);

  const content = (
    <>
      {image && (
        // eslint-disable-next-line @next/next/no-img-element -- OG images come from arbitrary hosts
        <img
          src={image}
          alt=""
          aria-hidden="true"
          referrerPolicy="no-referrer"
          loading="lazy"
          className="aspect-[1.91/1] w-full object-cover"
        />
      )}
      <div className="min-w-0 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs text-juke-text-on-dark-secondary">
            {getDomain(url)}
          </p>
          {miniApp && (
            <span className="flex shrink-0 items-center gap-1 rounded-full border border-juke-purple/60 bg-juke-purple/10 px-2 py-0.5 text-[10px] font-semibold text-juke-purple">
              Mini App <span aria-hidden>↗</span>
            </span>
          )}
        </div>
        {title && (
          <p className="mt-0.5 line-clamp-2 text-sm font-semibold text-juke-text-on-dark">
            {title}
          </p>
        )}
        {description && (
          <p className="mt-0.5 line-clamp-2 text-xs text-juke-text-on-dark-secondary">
            {description}
          </p>
        )}
      </div>
    </>
  );

  if (miniApp && launch) {
    return (
      <>
        <button
          type="button"
          aria-label={`Open ${title || launch.domain} mini app`}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (miniAppShell) {
              setMiniAppOpen(false);
              miniAppShell.openMiniApp({ launchUrl: launch.launchUrl, title });
            } else {
              setMiniAppOpen(true);
            }
          }}
          className="mt-2 block w-full overflow-hidden rounded-xl border border-juke-border bg-juke-navy/40 text-left transition-[border-color,transform] hover:-translate-y-px hover:border-juke-purple/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/60"
        >
          {content}
        </button>
        {miniAppOpen && !miniAppShell && (
          <MiniAppBrowser
            launchUrl={launch.launchUrl}
            title={title}
            onClose={() => setMiniAppOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      referrerPolicy="no-referrer"
      onClick={(event) => event.stopPropagation()}
      className="mt-2 block overflow-hidden rounded-xl border border-juke-border bg-juke-navy/40 transition-colors hover:border-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange/60"
    >
      {content}
    </a>
  );
}

// ---------------------------------------------------------------------------
// Quoted cast (Bug A)
// ---------------------------------------------------------------------------

function QuotedCast({ cast }: { cast: EmbeddedCast }) {
  const image = firstImageUrl(cast.embeds);

  return (
    <Link
      href={`/app/cast/${encodeURIComponent(cast.hash)}`}
      onClick={(event) => event.stopPropagation()}
      className="mt-2 block rounded-xl border border-juke-border p-3 transition-colors hover:border-white/25 hover:bg-white/[0.03]"
    >
      <div className="flex items-center gap-1.5">
        <Avatar src={cast.author.pfp_url} name={cast.author.display_name} size="xs" />
        <span className="truncate text-[13px] font-semibold text-juke-text-on-dark">
          {cast.author.display_name}
        </span>
        <span className="truncate text-[13px] text-juke-text-on-dark-secondary">
          @{cast.author.username}
        </span>
      </div>
      {cast.text && (
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-sm text-juke-text-on-dark-secondary">
          {cast.text}
        </p>
      )}
      {image && (
        // eslint-disable-next-line @next/next/no-img-element -- remote embed hosts vary
        <img
          src={image}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          className="mt-2 max-h-60 w-full rounded-lg border border-juke-border object-cover"
        />
      )}
    </Link>
  );
}
