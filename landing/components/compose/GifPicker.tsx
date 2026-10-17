"use client";

/**
 * GifPicker — modal GIF search/trending picker powered by /v1/gifs/*.
 *
 * Opening the picker triggers a trending fetch.  Typing in the search input
 * switches to search mode (300 ms debounce).  Selecting a GIF calls `onSelect`
 * and closes the modal.  "Load more" paginates via `nextOffset`.
 *
 * The modal reuses `landing/components/ui/modal.tsx` (ESC/backdrop close,
 * focus trap, scroll-lock) and does not add any extra accessibility burden.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Modal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  searchGifs,
  getTrendingGifs,
  type GifResult,
} from "@/lib/api/gifs";

const SEARCH_DEBOUNCE_MS = 300;

interface GifPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (gif: GifResult) => void;
}

interface GifPage {
  results: GifResult[];
  nextOffset: number | null;
}

export function GifPicker({ open, onClose, onSelect }: GifPickerProps) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<GifPage>({ results: [], nextOffset: null });
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch trending when the picker opens (or query becomes empty).
  const fetchTrending = useCallback(async (offset = 0) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    setError(null);

    try {
      const data = await getTrendingGifs(offset);
      if (mountedRef.current && !ac.signal.aborted) {
        setPage((prev) =>
          offset === 0
            ? data
            : { results: [...prev.results, ...data.results], nextOffset: data.nextOffset },
        );
      }
    } catch {
      if (mountedRef.current && !ac.signal.aborted) {
        setError("Failed to load GIFs.");
      }
    } finally {
      if (mountedRef.current && !ac.signal.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  const fetchSearch = useCallback(async (q: string, offset = 0) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    setError(null);

    try {
      const data = await searchGifs(q, offset);
      if (mountedRef.current && !ac.signal.aborted) {
        setPage((prev) =>
          offset === 0
            ? data
            : { results: [...prev.results, ...data.results], nextOffset: data.nextOffset },
        );
      }
    } catch {
      if (mountedRef.current && !ac.signal.aborted) {
        setError("Search failed.");
      }
    } finally {
      if (mountedRef.current && !ac.signal.aborted) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  // Fetch trending when opened.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setPage({ results: [], nextOffset: null });
    void fetchTrending(0);
  }, [open, fetchTrending]);

  // Debounce search; fall back to trending when query is cleared.
  const handleQueryChange = useCallback(
    (q: string) => {
      setQuery(q);
      setPage({ results: [], nextOffset: null });
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!q.trim()) {
        void fetchTrending(0);
        return;
      }
      debounceRef.current = setTimeout(() => {
        void fetchSearch(q.trim(), 0);
      }, SEARCH_DEBOUNCE_MS);
    },
    [fetchTrending, fetchSearch],
  );

  const handleLoadMore = useCallback(() => {
    if (page.nextOffset === null || loadingMore) return;
    if (query.trim()) {
      void fetchSearch(query.trim(), page.nextOffset);
    } else {
      void fetchTrending(page.nextOffset);
    }
  }, [page.nextOffset, loadingMore, query, fetchSearch, fetchTrending]);

  const handleSelect = useCallback(
    (gif: GifResult) => {
      onSelect(gif);
      onClose();
    },
    [onSelect, onClose],
  );

  // Clean up on unmount.
  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortRef.current?.abort();
    },
    [],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Choose a GIF"
      className="max-w-lg"
    >
      {/* Search input */}
      <input
        type="search"
        value={query}
        onChange={(e) => handleQueryChange(e.target.value)}
        placeholder="Search GIFs…"
        className="mb-4 w-full rounded-xl border border-juke-border bg-juke-navy/40 px-3 py-2 text-sm text-juke-text-on-dark placeholder:text-juke-text-on-dark-secondary focus:border-juke-orange focus:outline-none"
        aria-label="Search GIFs"
      />

      {/* Grid */}
      {loading ? (
        <div className="flex h-48 items-center justify-center">
          <Spinner size="md" label="Loading GIFs" />
        </div>
      ) : error ? (
        <p role="alert" className="py-8 text-center text-sm text-red-400">
          {error}
        </p>
      ) : page.results.length === 0 ? (
        <p className="py-8 text-center text-sm text-juke-text-on-dark-secondary">
          {query.trim() ? "No results." : "No trending GIFs."}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-1.5 overflow-y-auto" style={{ maxHeight: "360px" }}>
            {page.results.map((gif) => (
              <button
                key={gif.id}
                type="button"
                onClick={() => handleSelect(gif)}
                className={cn(
                  "group relative overflow-hidden rounded-lg bg-juke-navy/40 transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-juke-orange",
                )}
                aria-label="Select GIF"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- Giphy CDN URLs vary; next/image domain allow-list is impractical */}
                <img
                  src={gif.previewUrl}
                  alt=""
                  aria-hidden="true"
                  className="h-full w-full object-cover"
                  style={{
                    aspectRatio:
                      gif.width && gif.height
                        ? `${gif.width} / ${gif.height}`
                        : "1",
                  }}
                  loading="lazy"
                />
              </button>
            ))}
          </div>

          {page.nextOffset !== null && (
            <div className="mt-4 flex justify-center">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLoadMore}
                loading={loadingMore}
              >
                Load more
              </Button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
