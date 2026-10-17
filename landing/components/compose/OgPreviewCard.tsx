"use client";

/**
 * OG preview card + hook for the CastComposer.
 *
 * `useOgPreview(text)` — debounces URL extraction (600 ms), deduplicates
 * fetches (same URL is never refetched), and tracks a "dismissed" URL.  When
 * the URL in the text changes the dismissed state clears automatically.
 *
 * `OgPreviewCard` — compact card: thumbnail + title + hostname + × dismiss.
 * The URL stays in the composer text; no separate embed is sent.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { extractFirstUrl, getOgMetadata, type OgMetadata } from "@/lib/api/og";

// ---------------------------------------------------------------------------
// useOgPreview hook
// ---------------------------------------------------------------------------

export interface OgPreviewState {
  metadata: OgMetadata | null;
  dismiss: () => void;
}

const DEBOUNCE_MS = 600;

export function useOgPreview(text: string): OgPreviewState {
  const [metadata, setMetadata] = useState<OgMetadata | null>(null);
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);

  const lastFetchedUrlRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const url = extractFirstUrl(text);

    // No URL in text — clear card.
    if (!url) {
      setMetadata(null);
      return;
    }

    // URL changed from what was previously dismissed → clear dismissed state.
    if (dismissedUrl && url !== dismissedUrl) {
      setDismissedUrl(null);
    }

    // Don't refetch or re-show a dismissed URL.
    if (url === dismissedUrl) {
      return;
    }

    // Deduplicate: already fetched this URL successfully → nothing to do.
    if (url === lastFetchedUrlRef.current && metadata) {
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const data = await getOgMetadata(url);
        if (mountedRef.current && !ac.signal.aborted) {
          lastFetchedUrlRef.current = url;
          setMetadata(data);
        }
      } catch {
        // Non-fatal — no preview shown on error.
      }
    }, DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally omit metadata + dismissedUrl to avoid re-running on their change
  }, [text]);

  const dismiss = useCallback(() => {
    const url = extractFirstUrl(text);
    setDismissedUrl(url);
    setMetadata(null);
  }, [text]);

  return { metadata, dismiss };
}

// ---------------------------------------------------------------------------
// OgPreviewCard component
// ---------------------------------------------------------------------------

interface OgPreviewCardProps {
  metadata: OgMetadata;
  onDismiss: () => void;
}

export function OgPreviewCard({ metadata, onDismiss }: OgPreviewCardProps) {
  let hostname = "";
  try {
    hostname = new URL(metadata.url).hostname.replace(/^www\./, "");
  } catch {
    hostname = metadata.url;
  }

  return (
    <div className="relative mt-3 flex overflow-hidden rounded-xl border border-juke-border bg-juke-navy/40">
      {/* Thumbnail */}
      {metadata.image && /^https:\/\//i.test(metadata.image) && (
        // eslint-disable-next-line @next/next/no-img-element -- OG images come from arbitrary hosts
        <img
          src={metadata.image}
          alt=""
          aria-hidden="true"
          className="h-full w-24 shrink-0 object-cover"
          referrerPolicy="no-referrer"
        />
      )}

      {/* Text */}
      <div className="min-w-0 flex-1 p-3 pr-8">
        {metadata.title && (
          <p className="mb-0.5 truncate text-sm font-semibold text-juke-text-on-dark">
            {metadata.title}
          </p>
        )}
        {metadata.description && (
          <p className="mb-1 line-clamp-2 text-xs text-juke-text-on-dark-secondary">
            {metadata.description}
          </p>
        )}
        <p className="truncate text-xs text-juke-text-on-dark-secondary">
          {hostname}
        </p>
      </div>

      {/* Dismiss */}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss link preview"
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-juke-navy/80 text-sm text-white hover:bg-juke-navy"
      >
        ×
      </button>
    </div>
  );
}
