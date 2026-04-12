import { useEffect, useRef, useState } from 'react';
import { fetchOgMetadata, type OgMetadata } from '@/services/api';

const URL_RE = /https?:\/\/[^\s<)}\]]+/g;
const DEBOUNCE_MS = 600;

/** Strip trailing punctuation that's likely sentence-level, not part of the URL. */
function cleanUrl(raw: string): string {
  return raw.replace(/[.,;:!?)}\]]+$/, '');
}

/** Extract the first URL from text. */
function extractFirstUrl(text: string): string | null {
  const match = text.match(URL_RE);
  return match ? cleanUrl(match[0]) : null;
}

/** Extract all URLs from text. */
export function extractUrls(text: string): string[] {
  return (text.match(URL_RE) ?? []).map(cleanUrl);
}

/**
 * Watches text for URLs and fetches OG metadata via the backend.
 * Returns the metadata for the first detected URL (debounced).
 */
export function useOgPreview(text: string) {
  const [ogData, setOgData] = useState<OgMetadata | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const lastFetchedUrl = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const url = extractFirstUrl(text);

    // Clear preview if no URL in text
    if (!url) {
      setOgData(null);
      lastFetchedUrl.current = null;
      return;
    }

    // Already fetched this URL
    if (url === lastFetchedUrl.current) return;

    // Debounce the fetch
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      let cancelled = false;
      setIsLoading(true);
      lastFetchedUrl.current = url;

      fetchOgMetadata(url)
        .then((data) => {
          if (!cancelled) {
            // Only show preview if we got meaningful metadata
            const hasMeta = data.title || data.description || data.image;
            setOgData(hasMeta ? data : null);
          }
        })
        .catch(() => {
          if (!cancelled) setOgData(null);
        })
        .finally(() => {
          if (!cancelled) setIsLoading(false);
        });

      // Cleanup if text changes before fetch completes
      return () => {
        cancelled = true;
      };
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [text]);

  const dismissPreview = () => {
    setOgData(null);
    // Prevent re-fetching the same URL after dismiss
    lastFetchedUrl.current = extractFirstUrl(text);
  };

  return { ogData, isLoading, dismissPreview };
}
