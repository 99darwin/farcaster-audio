"use client";

/**
 * Windowed (virtualized) chat list.
 *
 * Only the rows intersecting the viewport (plus overscan) are mounted. Row
 * heights are measured with one ResizeObserver and cached by row key, so
 * prepending an older page never invalidates measurements. Scroll position is
 * anchored to a row (key + distance from the viewport top) across every
 * layout change: older pages loading above, estimates being corrected by real
 * measurements, embeds finishing loading. When the user is at the bottom the
 * list instead sticks to the bottom as new messages arrive. When the window
 * isn't at the live end (`hasNewer`, after a jump), reaching the bottom pages
 * forward instead.
 *
 * Keyboard: rows are a roving-tabindex set. ArrowUp/ArrowDown move between
 * messages, Home/End jump to the first/last loaded message; the row element
 * itself handles per-message keys (reply, react) in `renderRow`.
 */

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Spinner } from "@/components/ui/spinner";
import type { ScrollSnapshot } from "@/lib/messages/scroll-memory";
import type { ThreadRow } from "@/lib/messages/thread-rows";
import {
  captureAnchor,
  centeredScrollTop,
  computeLayout,
  restoreAnchor,
  visibleRange,
  type ScrollAnchor,
} from "@/lib/messages/windowing";

/** Extra rows rendered above/below the viewport, in px. */
const OVERSCAN_PX = 800;
/** Start loading the previous page this far from the top. */
const LOAD_OLDER_THRESHOLD_PX = 900;
/** Start loading the next page this far from the bottom (detached window). */
const LOAD_NEWER_THRESHOLD_PX = 900;
/** "At bottom" tolerance. */
const AT_BOTTOM_THRESHOLD_PX = 80;
/** Fixed-height list header (loading spinner / start of conversation). */
const HEADER_HEIGHT_PX = 56;
/** Viewport height assumed before the scroller has been measured. */
const UNMEASURED_VIEWPORT_PX = 800;

export interface ScrollRequest {
  /** Row key to bring into view, or null for the bottom. */
  rowKey: string | null;
  /** Changes on every request so repeated jumps to one row still fire. */
  nonce: number;
  /** "center" for jumps; "start" for the unread divider on open. */
  align?: "center" | "start";
}

export interface MessageListHandle {
  focusLastMessage: () => void;
  /** Focus a specific row (scrolls it into view first). */
  focusRow: (rowKey: string) => void;
  scrollToBottom: () => void;
}

export interface RenderRowContext {
  /** Roving tabindex value for the row's focusable element. */
  tabIndex: 0 | -1;
}

export interface MessageListProps {
  rows: readonly ThreadRow[];
  renderRow: (row: ThreadRow, context: RenderRowContext) => ReactNode;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  /** More messages exist below the loaded window (not at the live end). */
  hasNewer?: boolean;
  loadingNewer?: boolean;
  onLoadNewer?: () => void;
  /** Position to restore on mount (returning to a conversation). */
  initialSnapshot?: ScrollSnapshot | null;
  /** Reports the position as the user scrolls, for {@link initialSnapshot}. */
  onSnapshot?: (snapshot: ScrollSnapshot) => void;
  onAtBottomChange: (atBottom: boolean) => void;
  scrollRequest: ScrollRequest | null;
  /** Shown in the header once the first message is loaded. */
  beginningLabel?: string;
  ref?: Ref<MessageListHandle>;
}

function estimateRowHeight(row: ThreadRow): number {
  switch (row.kind) {
    case "day":
    case "unread":
      return 44;
    case "system":
      return 36;
    case "message": {
      const { message } = row;
      let height = row.isLastInGroup ? 60 : 50;
      height += Math.ceil(message.text.length / 48) * 20;
      if (message.in_reply_to) height += 52;
      if (message.metadata?.medias.length) height += 240;
      if (message.metadata?.urls.length) height += 96;
      if (message.reactions.length) height += 30;
      return height;
    }
  }
}

function isFocusableRow(row: ThreadRow | undefined): boolean {
  return row?.kind === "message";
}

export function MessageList({
  rows,
  renderRow,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  hasNewer = false,
  loadingNewer = false,
  onLoadNewer,
  initialSnapshot = null,
  onSnapshot,
  onAtBottomChange,
  scrollRequest,
  beginningLabel = "This is the beginning of your conversation",
  ref,
}: MessageListProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const sizesRef = useRef(new Map<string, number>());
  const [sizeVersion, setSizeVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);

  const stickToBottomRef = useRef(initialSnapshot?.kind !== "anchor");
  const anchorRef = useRef<ScrollAnchor | null>(
    initialSnapshot?.kind === "anchor" ? initialSnapshot.anchor : null,
  );
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const pendingRequestRef = useRef<ScrollRequest | null>(null);
  const handledNonceRef = useRef<number | null>(null);
  const pendingFocusKeyRef = useRef<string | null>(null);
  const atBottomRef = useRef(true);
  // Never stick to the bottom of a window that isn't the live end.
  const hasNewerRef = useRef(hasNewer);
  hasNewerRef.current = hasNewer;

  const keys = useMemo(() => rows.map((row) => row.key), [rows]);
  const layout = useMemo(
    () => computeLayout(keys, sizesRef.current, (i) => estimateRowHeight(rows[i])),
    // sizeVersion invalidates when measurements change (the Map is mutable).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [keys, rows, sizeVersion],
  );

  // Short threads sit at the bottom of the viewport, like every chat app.
  const topPad = Math.max(0, viewportHeight - HEADER_HEIGHT_PX - layout.totalHeight);
  const contentTop = topPad + HEADER_HEIGHT_PX;
  const contentTopRef = useRef(contentTop);
  contentTopRef.current = contentTop;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const range = visibleRange(
    layout.offsets,
    scrollTop - contentTop,
    viewportHeight || UNMEASURED_VIEWPORT_PX,
    OVERSCAN_PX,
  );

  // --- measurement -------------------------------------------------------

  const observerRef = useRef<ResizeObserver | null>(null);
  const observedRef = useRef(new Map<Element, string>());
  useEffect(() => {
    const observed = observedRef.current;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const key = observed.get(entry.target);
        if (!key) continue;
        const height =
          entry.borderBoxSize?.[0]?.blockSize ??
          (entry.target as HTMLElement).offsetHeight;
        if (height > 0 && Math.abs((sizesRef.current.get(key) ?? -1) - height) > 0.5) {
          sizesRef.current.set(key, height);
          changed = true;
        }
      }
      if (changed) setSizeVersion((v) => v + 1);
    });
    observerRef.current = observer;
    for (const element of observed.keys()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  // One stable ref callback per row key, so re-renders don't re-observe.
  const measureRefs = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const measureRef = useCallback((key: string) => {
    let callback = measureRefs.current.get(key);
    if (!callback) {
      let current: HTMLDivElement | null = null;
      callback = (element) => {
        if (current) {
          observedRef.current.delete(current);
          observerRef.current?.unobserve(current);
        }
        current = element;
        if (!element) return;
        observedRef.current.set(element, key);
        observerRef.current?.observe(element);
      };
      measureRefs.current.set(key, callback);
    }
    return callback;
  }, []);

  // Drop cached sizes and ref callbacks for rows that left the list (a jump
  // replaced the window, messages were deleted) so long sessions don't grow.
  useEffect(() => {
    const live = new Set(keys);
    for (const key of sizesRef.current.keys()) if (!live.has(key)) sizesRef.current.delete(key);
    for (const key of measureRefs.current.keys()) if (!live.has(key)) measureRefs.current.delete(key);
  }, [keys]);

  // --- scroll state ------------------------------------------------------

  const updateAtBottom = useCallback(
    (value: boolean) => {
      if (atBottomRef.current === value) return;
      atBottomRef.current = value;
      onAtBottomChange(value);
    },
    [onAtBottomChange],
  );

  const handleScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const isAtBottom = distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX;
    stickToBottomRef.current = isAtBottom && !hasNewerRef.current;
    updateAtBottom(isAtBottom);
    anchorRef.current = captureAnchor(
      keysRef.current,
      layoutRef.current.offsets,
      el.scrollTop - contentTopRef.current,
    );
    onSnapshotRef.current?.(
      stickToBottomRef.current || !anchorRef.current
        ? { kind: "bottom" }
        : { kind: "anchor", anchor: anchorRef.current },
    );
    setScrollTop(el.scrollTop);
  }, [updateAtBottom]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  const applyScrollTop = useCallback((value: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    if (Math.abs(el.scrollTop - value) > 0.5) el.scrollTop = value;
    setScrollTop(el.scrollTop);
  }, []);

  const runScrollRequest = useCallback(
    (request: ScrollRequest): boolean => {
      const el = scrollerRef.current;
      if (!el) return false;
      if (request.rowKey === null) {
        stickToBottomRef.current = true;
        applyScrollTop(el.scrollHeight);
        return true;
      }
      const index = keysRef.current.indexOf(request.rowKey);
      if (index === -1) return false;
      const { offsets } = layoutRef.current;
      const viewport = el.clientHeight;
      const target =
        request.align === "start"
          ? Math.max(0, offsets[index] - viewport * 0.25)
          : centeredScrollTop(offsets, index, viewport);
      stickToBottomRef.current = false;
      // Anchor on the target row so measurement corrections keep it in place.
      anchorRef.current = {
        key: request.rowKey,
        delta: offsets[index] - target,
      };
      applyScrollTop(target + contentTopRef.current);
      return true;
    },
    [applyScrollTop],
  );

  // Register new scroll requests.
  useEffect(() => {
    if (!scrollRequest || handledNonceRef.current === scrollRequest.nonce) return;
    handledNonceRef.current = scrollRequest.nonce;
    pendingRequestRef.current = scrollRequest;
    if (runScrollRequest(scrollRequest)) pendingRequestRef.current = null;
  }, [scrollRequest, runScrollRequest]);

  // Re-anchor after every layout change, before paint.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const pending = pendingRequestRef.current;
    if (pending && runScrollRequest(pending)) {
      pendingRequestRef.current = null;
      return;
    }
    if (stickToBottomRef.current) {
      applyScrollTop(el.scrollHeight - el.clientHeight);
      return;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const restored = restoreAnchor(anchor, keys, layout.offsets);
    if (restored !== null) applyScrollTop(restored + contentTop);
  }, [keys, layout, contentTop, runScrollRequest, applyScrollTop]);

  // Load the previous page when near the top (also covers short threads).
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !hasOlder || loadingOlder || rows.length === 0) return;
    // Read the live position: a layout effect may have just moved it.
    if (el.scrollTop - contentTop < LOAD_OLDER_THRESHOLD_PX) onLoadOlder();
  }, [scrollTop, contentTop, hasOlder, loadingOlder, onLoadOlder, rows.length, layout.totalHeight]);

  // Page forward when near the bottom of a detached window.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !hasNewer || loadingNewer || !onLoadNewer || rows.length === 0) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < LOAD_NEWER_THRESHOLD_PX) onLoadNewer();
  }, [scrollTop, hasNewer, loadingNewer, onLoadNewer, rows.length, layout.totalHeight]);

  // --- keyboard ----------------------------------------------------------

  const focusRowKey = useCallback(
    (key: string) => {
      setFocusedKey(key);
      const element = scrollerRef.current?.querySelector<HTMLElement>(
        `[data-row-key="${CSS.escape(key)}"] [data-row-focus]`,
      );
      if (element) {
        element.focus({ preventScroll: false });
        return;
      }
      // Not mounted: scroll it into the window first, focus after render.
      pendingFocusKeyRef.current = key;
      runScrollRequest({ rowKey: key, nonce: -1, align: "center" });
    },
    [runScrollRequest],
  );

  useEffect(() => {
    const key = pendingFocusKeyRef.current;
    if (!key) return;
    const element = scrollerRef.current?.querySelector<HTMLElement>(
      `[data-row-key="${CSS.escape(key)}"] [data-row-focus]`,
    );
    if (element) {
      pendingFocusKeyRef.current = null;
      element.focus({ preventScroll: true });
    }
  });

  const lastMessageKey = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (isFocusableRow(rows[i])) return rows[i].key;
    }
    return null;
  }, [rows]);

  const rovingKey =
    focusedKey && keys.includes(focusedKey) ? focusedKey : lastMessageKey;

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement;
      if (!target.hasAttribute("data-row-focus")) return;
      const rowKey = target.closest<HTMLElement>("[data-row-key]")?.dataset.rowKey;
      if (!rowKey) return;
      const index = keys.indexOf(rowKey);
      let next = -1;
      if (event.key === "ArrowUp") {
        for (let i = index - 1; i >= 0; i -= 1) if (isFocusableRow(rows[i])) { next = i; break; }
        if (next === -1 && hasOlder) onLoadOlder();
      } else if (event.key === "ArrowDown") {
        for (let i = index + 1; i < rows.length; i += 1) if (isFocusableRow(rows[i])) { next = i; break; }
        if (next === -1 && hasNewer) onLoadNewer?.();
      } else if (event.key === "Home") {
        next = rows.findIndex(isFocusableRow);
      } else if (event.key === "End") {
        next = lastMessageKey ? keys.indexOf(lastMessageKey) : -1;
      } else {
        return;
      }
      event.preventDefault();
      if (next !== -1) focusRowKey(keys[next]);
    },
    [keys, rows, hasOlder, onLoadOlder, hasNewer, onLoadNewer, lastMessageKey, focusRowKey],
  );

  useImperativeHandle(
    ref,
    () => ({
      focusLastMessage: () => {
        if (lastMessageKey) focusRowKey(lastMessageKey);
      },
      focusRow: focusRowKey,
      scrollToBottom: () => {
        runScrollRequest({ rowKey: null, nonce: -1 });
      },
    }),
    [lastMessageKey, focusRowKey, runScrollRequest],
  );

  // --- render ------------------------------------------------------------

  const visibleRows: ReactNode[] = [];
  for (let i = range.start; i < range.end; i += 1) {
    const row = rows[i];
    visibleRows.push(
      <div
        key={row.key}
        ref={measureRef(row.key)}
        data-row-key={row.key}
        className="absolute inset-x-0"
        style={{ top: layout.offsets[i] }}
      >
        {renderRow(row, { tabIndex: row.key === rovingKey ? 0 : -1 })}
      </div>,
    );
  }

  return (
    <div
      ref={scrollerRef}
      onScroll={handleScroll}
      onKeyDown={handleKeyDown}
      onFocus={(event) => {
        const key = (event.target as HTMLElement)
          .closest<HTMLElement>("[data-row-key]")
          ?.dataset.rowKey;
        if (key && (event.target as HTMLElement).hasAttribute("data-row-focus")) {
          setFocusedKey(key);
        }
      }}
      role="log"
      aria-label="Messages"
      // New-message announcements come from a dedicated live region; mounting
      // and unmounting virtual rows on scroll must not be read out.
      aria-live="off"
      className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain [overflow-anchor:none]"
    >
      <div style={{ height: contentTop + layout.totalHeight + (hasNewer ? HEADER_HEIGHT_PX : 0) }} className="relative">
        <div
          className="absolute inset-x-0 flex items-center justify-center"
          style={{ top: topPad, height: HEADER_HEIGHT_PX }}
        >
          {loadingOlder ? (
            <Spinner size="sm" label="Loading older messages" />
          ) : !hasOlder && rows.length > 0 ? (
            <p className="text-xs text-juke-text-on-dark-tertiary">{beginningLabel}</p>
          ) : null}
        </div>
        <div className="absolute inset-x-0" style={{ top: contentTop }}>
          {visibleRows}
        </div>
        {hasNewer && (
          <div
            className="absolute inset-x-0 flex items-center justify-center"
            style={{ top: contentTop + layout.totalHeight, height: HEADER_HEIGHT_PX }}
          >
            {loadingNewer && <Spinner size="sm" label="Loading newer messages" />}
          </div>
        )}
      </div>
    </div>
  );
}
