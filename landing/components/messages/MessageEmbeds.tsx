"use client";

import type { MessageMetadata, MessageUrlEmbed } from "@/lib/api/messages.types";
import { safeImageUrl, safeLinkUrl } from "@/lib/safe-url";
import { cn } from "@/components/ui/cn";

/** Max rendered media width; images keep their aspect ratio below it. */
const MEDIA_MAX_WIDTH_PX = 280;
const MEDIA_MAX_HEIGHT_PX = 320;
/** Box height when the media's dimensions are unknown. */
const MEDIA_FALLBACK_HEIGHT_PX = 200;

function mediaBox(width: number, height: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: MEDIA_MAX_WIDTH_PX, height: MEDIA_FALLBACK_HEIGHT_PX };
  const scale = Math.min(1, MEDIA_MAX_WIDTH_PX / width, MEDIA_MAX_HEIGHT_PX / height);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function UrlEmbedCard({
  embed,
  className,
}: {
  embed: MessageUrlEmbed;
  className?: string;
}) {
  const href = safeLinkUrl(embed.url);
  const image = safeImageUrl(embed.image_url);
  if (!href) return null;
  const domain = embed.domain ?? (() => {
    try {
      return new URL(href).hostname;
    } catch {
      return href;
    }
  })();
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "block max-w-[280px] overflow-hidden rounded-xl border border-juke-border bg-juke-navy/60 text-left transition-colors hover:bg-juke-navy",
        className,
      )}
    >
      {image && (
        // eslint-disable-next-line @next/next/no-img-element -- arbitrary OG hosts
        <img
          src={image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className="aspect-[1.91/1] w-full object-cover"
        />
      )}
      <span className="block px-3 py-2">
        <span className="block truncate text-[11px] uppercase tracking-wide text-juke-text-on-dark-tertiary">
          {domain}
        </span>
        {embed.title && (
          <span className="mt-0.5 line-clamp-2 block text-sm font-semibold text-juke-text-on-dark">
            {embed.title}
          </span>
        )}
        {embed.description && (
          <span className="mt-0.5 line-clamp-2 block text-xs text-juke-text-on-dark-secondary">
            {embed.description}
          </span>
        )}
      </span>
    </a>
  );
}

/** Images (in order) then the first link card, under the message text. */
export function MessageEmbeds({ metadata }: { metadata: MessageMetadata }) {
  const medias = metadata.medias
    .map((media) => ({ ...media, src: safeImageUrl(media.url) }))
    .filter((media): media is typeof media & { src: string } => media.src !== null);
  const firstUrl = metadata.urls[0];
  if (medias.length === 0 && !firstUrl) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {medias.map((media, index) => {
        const box = mediaBox(media.width, media.height);
        return (
          <a
            key={`${index}:${media.url}`}
            href={media.src}
            target="_blank"
            rel="noopener noreferrer"
            className="block overflow-hidden rounded-xl"
            style={{ width: box.width, maxWidth: "100%" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary media hosts */}
            <img
              src={media.src}
              alt="Shared image"
              loading="lazy"
              referrerPolicy="no-referrer"
              width={box.width}
              height={box.height}
              className="h-auto w-full bg-juke-navy object-cover"
              style={{ aspectRatio: `${box.width} / ${box.height}` }}
            />
          </a>
        );
      })}
      {firstUrl && <UrlEmbedCard embed={firstUrl} />}
    </div>
  );
}
