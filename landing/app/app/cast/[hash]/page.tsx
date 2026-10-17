"use client";

/**
 * Cast thread screen — mirrors mobile `app/cast/[hash].tsx`.
 *
 * Renders the focused (root) cast expanded above its nested reply tree
 * (`ThreadedReplies`) with an inline reply box beneath it. Reactions/bookmarks
 * are optimistic across the whole tree via `updateTree` (structural sharing, so
 * only the touched branch re-renders); a failed write reverts just the affected
 * node — the toggle is its own inverse. Reply/quote on any node opens the shared
 * compose modal. `?focus={hash}` deep-links a specific reply: it scrolls into
 * view and gets a focus highlight after load. When the root itself is a reply,
 * its parent chain renders inline above it (X-style), joined avatar-to-avatar
 * by a thread line, and the page opens scrolled to the focal cast.
 */

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { CastCard } from "@/components/ui/cast-card";
import {
  ThreadedReplies,
  ThreadSlopFooter,
} from "@/components/thread/ThreadedReplies";
import { InlineReplyBox } from "@/components/thread/InlineReplyBox";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  useComposeStore,
  OPTIMISTIC_REPLY_WINDOW_MS,
} from "@/lib/stores/composeStore";
import {
  findTopLevelIndexContaining,
  insertReply,
  partitionSpamFromTree,
  removeFromTree,
  subtreeContainsHash,
  updateTree,
  type CastNode,
} from "@/lib/thread/thread-tree";
import type { Cast } from "@/lib/api/types";
import {
  applyBookmark,
  applyReaction,
  bookmarkCast,
  getCastThread,
  likeCast,
  recastCast,
  unbookmarkCast,
  unlikeCast,
  unrecastCast,
} from "@/lib/api/users";
import { deleteCast } from "@/lib/api/feed";
import {
  identityCast,
  useCastListNavigation,
} from "@/lib/keyboard/useCastListNavigation";

function CastThreadView() {
  const params = useParams<{ hash: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const hash = params.hash;
  const focusHash = searchParams.get("focus") ?? undefined;
  const openCompose = useComposeStore((s) => s.openCompose);
  const lastPublished = useComposeStore((s) => s.lastPublished);
  const { user } = useAuth();

  const [root, setRoot] = useState<Cast | null>(null);
  const [ancestors, setAncestors] = useState<Cast[]>([]);
  const [replies, setReplies] = useState<CastNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getCastThread(hash)
      .then((thread) => {
        if (!active) return;
        if (!thread.root) {
          setError("This cast could not be found.");
          return;
        }
        setRoot(thread.root);
        setAncestors(thread.ancestors);
        setReplies(thread.replies);
      })
      .catch(() => {
        if (active) setError("This cast could not be loaded.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [hash]);

  useEffect(() => load(), [load]);

  // Deep-link: scroll the focused reply into view once the tree has rendered.
  // Without one, a reply opens with its focal cast at the top and the parent
  // chain above it, one scroll up — the way X lands on a reply.
  const hasAncestors = ancestors.length > 0;
  useEffect(() => {
    if (loading) return;
    if (focusHash) {
      document
        .getElementById(`cast-${focusHash}`)
        ?.scrollIntoView({ block: "center" });
      return;
    }
    if (hasAncestors) {
      document
        .getElementById(`cast-${hash}`)
        ?.scrollIntoView({ block: "start" });
    }
  }, [focusHash, hash, hasAncestors, loading, replies]);

  // Optimistically patch a cast wherever it lives (root or any reply node).
  // `fn` operates on the flat `Cast` fields; on a node the runtime spread keeps
  // `replies`/`authorIsSpam`, so the cast back to `CastNode` is sound.
  const patchCast = useCallback((target: string, fn: (c: Cast) => Cast) => {
    setRoot((r) => (r && r.hash === target ? fn(r) : r));
    setAncestors((prev) => prev.map((c) => (c.hash === target ? fn(c) : c)));
    setReplies((prev) => updateTree(prev, target, (n) => fn(n) as CastNode));
  }, []);

  const handleLike = useCallback(
    (cast: Cast) => {
      const wasLiked = cast.reactions.viewer_liked;
      patchCast(cast.hash, (c) => applyReaction(c, "like"));
      (wasLiked ? unlikeCast(cast.hash) : likeCast(cast.hash)).catch(() =>
        patchCast(cast.hash, (c) => applyReaction(c, "like")),
      );
    },
    [patchCast],
  );

  const handleRecast = useCallback(
    (cast: Cast) => {
      const wasRecast = cast.reactions.viewer_recasted;
      patchCast(cast.hash, (c) => applyReaction(c, "recast"));
      (wasRecast ? unrecastCast(cast.hash) : recastCast(cast.hash)).catch(() =>
        patchCast(cast.hash, (c) => applyReaction(c, "recast")),
      );
    },
    [patchCast],
  );

  const handleBookmark = useCallback(
    (cast: Cast) => {
      const wasBookmarked = cast.viewer_bookmarked;
      patchCast(cast.hash, applyBookmark);
      (wasBookmarked
        ? unbookmarkCast(cast.hash)
        : bookmarkCast(cast.hash)
      ).catch(() => patchCast(cast.hash, applyBookmark));
    },
    [patchCast],
  );

  const handleReply = useCallback(
    (cast: Cast) => {
      openCompose({
        mode: "reply",
        target: { hash: cast.hash, author: cast.author },
      });
    },
    [openCompose],
  );

  const handleQuote = useCallback(
    (cast: Cast) => {
      openCompose({
        mode: "quote",
        target: { hash: cast.hash, author: cast.author },
      });
    },
    [openCompose],
  );

  const handlePress = useCallback(
    (cast: Cast) => {
      if (cast.hash !== hash) router.push(`/app/cast/${cast.hash}`);
    },
    [hash, router],
  );

  // Delete the root cast — navigates back to the home feed on success.
  // No optimistic UI here: setting root=null would flash "Cast unavailable"
  // while the DELETE is in flight. Navigate only after the API confirms.
  const handleDeleteRoot = useCallback(
    (cast: Cast) => {
      deleteCast(cast.hash)
        .then(() => router.push("/app"))
        .catch(() => {
          // Stay on the thread page; the cast is still present.
        });
    },
    [router],
  );

  // Delete a reply node — removes it (and its subtree) from the local tree.
  // Non-optimistic: remove only after the API confirms. This avoids a
  // non-functional-updater revert that could stomp concurrent deletes.
  const handleDeleteReply = useCallback(
    (cast: Cast) => {
      deleteCast(cast.hash)
        .then(() => {
          setReplies((prev) => removeFromTree(prev, cast.hash));
        })
        .catch(() => {
          // Cast stays visible; no state to revert.
        });
    },
    [],
  );

  // Prepend an optimistic reply from the inline box to the top of the tree.
  const handleReplyPublished = useCallback((node: CastNode) => {
    setReplies((prev) => [node, ...prev]);
  }, []);

  // Instant reply parity for the SHARED compose modal (the per-node "Reply"
  // button opens it). InlineReplyBox handles its own insert and never sets
  // `lastPublished`, so there is no double-insert here; the hash dedup in
  // `insertReply` is the belt-and-braces guard. Only replies whose target is
  // the root or a node already in the tree are inserted.
  const lastHandledReply = useRef(0);
  useEffect(() => {
    if (!lastPublished || lastPublished.mode !== "reply") return;
    if (lastPublished.at <= lastHandledReply.current) return;
    if (Date.now() - lastPublished.at > OPTIMISTIC_REPLY_WINDOW_MS) return;
    const targetHash = lastPublished.target?.hash;
    if (!targetHash || !root) return;

    const node: CastNode = {
      ...lastPublished.cast,
      replies: [],
      authorIsSpam: false,
    };

    // Reply to the root cast → prepend at the top level + bump root's count.
    if (targetHash === root.hash) {
      lastHandledReply.current = lastPublished.at;
      setReplies((prev) =>
        prev.some((n) => subtreeContainsHash(n, node.hash))
          ? prev
          : [node, ...prev],
      );
      setRoot((r) =>
        r
          ? {
              ...r,
              reactions: {
                ...r.reactions,
                replies_count: r.reactions.replies_count + 1,
              },
            }
          : r,
      );
      return;
    }

    // Reply to a nested node already in the tree → insert under that parent.
    if (findTopLevelIndexContaining(replies, targetHash) >= 0) {
      lastHandledReply.current = lastPublished.at;
      setReplies((prev) => insertReply(prev, targetHash, node));
    }
  }, [lastPublished, root, replies]);

  const { clean, spam } = useMemo(
    () => partitionSpamFromTree(replies),
    [replies],
  );

  // Keyboard navigation for the thread: j/k traverse the root cast and the
  // top-level replies, r/l/t/b act on the focused one, Enter opens a reply's
  // own thread. Without this the whole keyboard interface goes dead on the
  // thread route (only the app-wide g-chords keep working). Nested replies stay
  // mouse-navigable — the focus ring covers depth-0 nodes only.
  const orderedCasts = useMemo<Cast[]>(
    () => (root ? [root, ...clean] : []),
    [root, clean],
  );

  const { focusedIndex } = useCastListNavigation({
    items: orderedCasts,
    getCast: identityCast,
    // Enter on a reply opens its thread; on the root (its own thread) it no-ops
    // via the same guard `handlePress` uses.
    onOpen: handlePress,
    onLike: handleLike,
    onReply: handleReply,
    onRecast: handleRecast,
    onBookmark: handleBookmark,
  });

  const keyboardFocusHash =
    focusedIndex >= 0 ? orderedCasts[focusedIndex]?.hash : undefined;

  const rowIndexByHash = useMemo(() => {
    const m = new Map<string, number>();
    orderedCasts.forEach((c, i) => m.set(c.hash, i));
    return m;
  }, [orderedCasts]);

  // `data-feed-index` lets useFeedNavigation's scroll logic locate the focused
  // row. Root is index 0; top-level replies follow in order.
  const getRowProps = useCallback(
    (h: string): Record<string, unknown> => {
      const idx = rowIndexByHash.get(h);
      return idx === undefined ? {} : { "data-feed-index": idx };
    },
    [rowIndexByHash],
  );

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error || !root) {
    return (
      <EmptyState
        title="Cast unavailable"
        description={error ?? "This cast could not be loaded."}
        action={
          <Button variant="ghost" onClick={() => router.back()}>
            Go back
          </Button>
        }
      />
    );
  }

  const nodeHandlers = {
    onLike: handleLike,
    onRecast: handleRecast,
    onBookmark: handleBookmark,
    onReply: handleReply,
    onQuote: handleQuote,
    onPress: handlePress,
    // Reply delete — ownership gating happens in ThreadedReplies via userFid.
    onDelete: handleDeleteReply,
    userFid: user?.fid,
  };

  return (
    <div>
      <div className="flex items-center gap-2 border-b border-juke-border px-4 py-3">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label="Go back"
          className="rounded-full px-2 py-1 text-sm text-juke-text-on-dark-secondary transition-colors hover:text-juke-text-on-dark"
        >
          &larr; Back
        </button>
        <h1 className="text-sm font-semibold text-juke-text-on-dark">Thread</h1>
      </div>

      {/* Chain deeper than the backend's ancestor cap: hop to the oldest. */}
      {ancestors[0]?.parent_hash && (
        <button
          type="button"
          onClick={() =>
            router.push(
              `/app/cast/${encodeURIComponent(ancestors[0].parent_hash ?? "")}`,
            )
          }
          className="block w-full px-4 pt-3 text-left text-sm text-juke-purple hover:underline"
        >
          Show earlier replies
        </button>
      )}

      {ancestors.map((ancestor, index) => (
        <div key={ancestor.hash} id={`cast-${ancestor.hash}`}>
          <CastCard
            cast={ancestor}
            detail
            connectAbove={index > 0}
            connectBelow
            onLike={handleLike}
            onRecast={handleRecast}
            onBookmark={handleBookmark}
            onReply={handleReply}
            onQuote={handleQuote}
            onPress={handlePress}
          />
        </div>
      ))}

      {/*
        X keeps the focal post pinnable to the top even when little follows it:
        the focal-and-below section is at least a viewport tall, and
        scroll-margin clears the sticky app header.
      */}
      <div className={hasAncestors ? "min-h-[100dvh]" : undefined}>
        <div
          id={`cast-${root.hash}`}
          className="scroll-mt-14"
          {...getRowProps(root.hash)}
        >
          <CastCard
            cast={root}
            focal
            connectAbove={hasAncestors}
            focused={
              (!!focusHash && root.hash === focusHash) ||
              keyboardFocusHash === root.hash
            }
            onLike={handleLike}
            onRecast={handleRecast}
            onBookmark={handleBookmark}
            onReply={handleReply}
            onQuote={handleQuote}
            onDelete={
              user?.fid !== undefined && root.author.fid === user.fid
                ? handleDeleteRoot
                : undefined
            }
          />
        </div>

        <InlineReplyBox root={root} onReplyPublished={handleReplyPublished} />

        {clean.length === 0 && spam.length === 0 ? (
          <EmptyState title="No replies yet" />
        ) : (
          <>
            <ThreadedReplies
              replies={clean}
              focusHash={focusHash}
              keyboardFocusHash={keyboardFocusHash}
              getRowProps={getRowProps}
              {...nodeHandlers}
            />
            <ThreadSlopFooter
              spam={spam}
              focusHash={focusHash}
              {...nodeHandlers}
            />
          </>
        )}
      </div>
    </div>
  );
}

export default function CastThreadPage() {
  return (
    <Suspense
      fallback={
        <div className="flex justify-center py-20">
          <Spinner size="lg" />
        </div>
      }
    >
      <CastThreadView />
    </Suspense>
  );
}
