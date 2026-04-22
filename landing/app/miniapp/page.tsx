"use client";

import { useCallback, useEffect, useState } from "react";
import sdk from "@farcaster/miniapp-sdk";
import { LiveSpacesStrip } from "@/components/live-spaces-strip";
import { VoiceNoteFeedItem } from "@/components/voice-note-feed-item";
import {
  getRecentVoiceNotes,
  type VoiceNoteDetail,
} from "@/lib/voice-notes";

const APP_STORE_URL =
  "https://apps.apple.com/app/juke-audio/id6746423951";

export default function MiniAppHome() {
  const [items, setItems] = useState<VoiceNoteDetail[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sdk.actions.ready().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[miniapp] sdk.actions.ready failed", err);
    });
    fetchInitial();
  }, []);

  async function fetchInitial() {
    setIsLoading(true);
    setError(null);
    try {
      const res = await getRecentVoiceNotes();
      setItems(res.voice_notes);
      setCursor(res.next_cursor);
      setHasMore(!!res.next_cursor);
    } catch {
      setError("Couldn't load voice notes");
    } finally {
      setIsLoading(false);
    }
  }

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    setIsLoading(true);
    try {
      const res = await getRecentVoiceNotes(cursor);
      setItems((prev) => [...prev, ...res.voice_notes]);
      setCursor(res.next_cursor);
      setHasMore(!!res.next_cursor);
    } catch {
      setError("Couldn't load more");
    } finally {
      setIsLoading(false);
    }
  }, [cursor]);

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="flex items-center gap-2">
          <img
            src="/logomark.png"
            alt=""
            width={24}
            height={24}
            className="h-6 w-6 brightness-0 invert"
          />
          <span className="text-sm font-bold tracking-[0.15em]">JUKE</span>
        </div>
        <a
          href={APP_STORE_URL}
          className="text-xs font-medium text-white/50 transition-colors hover:text-white/80"
        >
          Get App
        </a>
      </header>

      {/* Live spaces strip (renders nothing when no active spaces) */}
      <LiveSpacesStrip />

      {/* Feed */}
      <div className="flex-1">
        {isLoading && items.length === 0 ? (
          <div className="space-y-0">
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="flex items-center gap-3 border-b border-white/10 px-4 py-3"
              >
                <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-white/10" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-24 animate-pulse rounded bg-white/10" />
                  <div className="h-2.5 w-40 animate-pulse rounded bg-white/5" />
                </div>
                <div className="h-3 w-10 animate-pulse rounded bg-white/10" />
              </div>
            ))}
          </div>
        ) : error && items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-20">
            <p className="mb-4 text-sm text-white/50">{error}</p>
            <button
              onClick={fetchInitial}
              className="rounded-full bg-white/10 px-5 py-2 text-xs font-medium text-white/70 transition-colors hover:bg-white/15"
            >
              Retry
            </button>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-20">
            <p className="text-sm text-white/50">No voice notes yet</p>
          </div>
        ) : (
          <>
            {items.map((item) => (
              <VoiceNoteFeedItem key={item.voice_note.id} item={item} />
            ))}

            {hasMore && (
              <div className="px-4 py-4">
                <button
                  onClick={loadMore}
                  disabled={isLoading}
                  className="w-full rounded-full bg-white/10 py-2.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/15 disabled:opacity-50"
                >
                  {isLoading ? "Loading..." : "Load more"}
                </button>
              </div>
            )}

            {error && items.length > 0 && (
              <p className="px-4 py-2 text-center text-xs text-red-400/60">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
