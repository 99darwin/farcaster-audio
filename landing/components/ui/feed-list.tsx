"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { Spinner } from "./spinner";
import { cn } from "./cn";

export interface FeedListProps<T> {
  items: T[];
  renderItem: (item: T, index: number) => ReactNode;
  /** Called when the sentinel scrolls into view and more pages exist. */
  onLoadMore?: () => void;
  hasMore?: boolean;
  loading?: boolean;
  /** Stable key extractor; falls back to array index when omitted. */
  getKey?: (item: T, index: number) => string | number;
  /** Rendered when `items` is empty and not loading. */
  emptyState?: ReactNode;
  className?: string;
}

/**
 * Generic infinite-scroll list. An IntersectionObserver sentinel near the
 * bottom triggers `onLoadMore` while `hasMore` is true and no load is already
 * in flight. Rendering of each row is fully delegated to the caller.
 */
export function FeedList<T>({
  items,
  renderItem,
  onLoadMore,
  hasMore = false,
  loading = false,
  getKey,
  emptyState,
  className,
}: FeedListProps<T>) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Keep the latest callback/flags without re-subscribing the observer.
  const stateRef = useRef({ onLoadMore, hasMore, loading });
  stateRef.current = { onLoadMore, hasMore, loading };

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry?.isIntersecting) return;
        const { onLoadMore: cb, hasMore: more, loading: busy } =
          stateRef.current;
        if (more && !busy && cb) cb();
      },
      { rootMargin: "200px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (items.length === 0 && !loading && emptyState) {
    return <>{emptyState}</>;
  }

  return (
    <div className={cn("flex flex-col", className)}>
      {items.map((item, index) => (
        <div key={getKey ? getKey(item, index) : index}>
          {renderItem(item, index)}
        </div>
      ))}

      {/* Sentinel: kept mounted so the observer can re-trigger across pages. */}
      <div ref={sentinelRef} aria-hidden className="h-px w-full" />

      {loading && (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      )}
    </div>
  );
}
