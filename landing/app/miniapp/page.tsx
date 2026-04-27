"use client";

import { useCallback, useEffect, useState } from "react";
import sdk from "@farcaster/miniapp-sdk";
import { LiveSpacesStrip } from "@/components/live-spaces-strip";
import { RecordingFeedItem } from "@/components/recording-feed-item";
import { VoiceNoteFeedItem } from "@/components/voice-note-feed-item";
import {
  getRecentRecordings,
  type RecordingFeedItem as RecordingItem,
} from "@/lib/recordings";
import {
  getRecentVoiceNotes,
  type VoiceNoteDetail,
} from "@/lib/voice-notes";

const APP_STORE_URL =
  "https://apps.apple.com/app/juke-audio/id6746423951";

type Tab = "voice-notes" | "recordings";

interface FeedState<T> {
  items: T[];
  cursor: string | null;
  isLoading: boolean;
  hasMore: boolean;
  error: string | null;
  loaded: boolean;
}

const initialFeed = <T,>(): FeedState<T> => ({
  items: [],
  cursor: null,
  isLoading: false,
  hasMore: false,
  error: null,
  loaded: false,
});

export default function MiniAppHome() {
  const [tab, setTab] = useState<Tab>("voice-notes");
  const [voiceNotes, setVoiceNotes] = useState<FeedState<VoiceNoteDetail>>(
    initialFeed,
  );
  const [recordings, setRecordings] = useState<FeedState<RecordingItem>>(
    initialFeed,
  );

  useEffect(() => {
    sdk.actions.ready().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("[miniapp] sdk.actions.ready failed", err);
    });
  }, []);

  const fetchVoiceNotes = useCallback(async (cursor?: string) => {
    setVoiceNotes((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await getRecentVoiceNotes(cursor);
      setVoiceNotes((s) => ({
        items: cursor ? [...s.items, ...res.voice_notes] : res.voice_notes,
        cursor: res.next_cursor,
        isLoading: false,
        hasMore: !!res.next_cursor,
        error: null,
        loaded: true,
      }));
    } catch {
      setVoiceNotes((s) => ({
        ...s,
        isLoading: false,
        error: cursor ? "Couldn't load more" : "Couldn't load voice notes",
        loaded: true,
      }));
    }
  }, []);

  const fetchRecordings = useCallback(async (cursor?: string) => {
    setRecordings((s) => ({ ...s, isLoading: true, error: null }));
    try {
      const res = await getRecentRecordings(cursor);
      setRecordings((s) => ({
        items: cursor ? [...s.items, ...res.items] : res.items,
        cursor: res.next_cursor,
        isLoading: false,
        hasMore: !!res.next_cursor,
        error: null,
        loaded: true,
      }));
    } catch {
      setRecordings((s) => ({
        ...s,
        isLoading: false,
        error: cursor ? "Couldn't load more" : "Couldn't load recordings",
        loaded: true,
      }));
    }
  }, []);

  useEffect(() => {
    if (tab === "voice-notes" && !voiceNotes.loaded) {
      fetchVoiceNotes();
    }
    if (tab === "recordings" && !recordings.loaded) {
      fetchRecordings();
    }
  }, [tab, voiceNotes.loaded, recordings.loaded, fetchVoiceNotes, fetchRecordings]);

  const activeFeed = tab === "voice-notes" ? voiceNotes : recordings;
  const activeRetry = tab === "voice-notes" ? fetchVoiceNotes : fetchRecordings;
  const loadMore = useCallback(() => {
    if (tab === "voice-notes" && voiceNotes.cursor) {
      fetchVoiceNotes(voiceNotes.cursor);
    } else if (tab === "recordings" && recordings.cursor) {
      fetchRecordings(recordings.cursor);
    }
  }, [tab, voiceNotes.cursor, recordings.cursor, fetchVoiceNotes, fetchRecordings]);

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

      {/* Tabs */}
      <div
        role="tablist"
        aria-label="Feed"
        className="flex border-b border-white/10"
      >
        <TabButton
          label="Voice Notes"
          active={tab === "voice-notes"}
          onClick={() => setTab("voice-notes")}
        />
        <TabButton
          label="Recordings"
          active={tab === "recordings"}
          onClick={() => setTab("recordings")}
        />
      </div>

      {/* Feed */}
      <div className="flex-1">
        {activeFeed.isLoading && activeFeed.items.length === 0 ? (
          <FeedSkeleton />
        ) : activeFeed.error && activeFeed.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-20">
            <p className="mb-4 text-sm text-white/50">{activeFeed.error}</p>
            <button
              onClick={() => activeRetry()}
              className="rounded-full bg-white/10 px-5 py-2 text-xs font-medium text-white/70 transition-colors hover:bg-white/15"
            >
              Retry
            </button>
          </div>
        ) : activeFeed.items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-20">
            <p className="text-sm text-white/50">
              {tab === "voice-notes"
                ? "No voice notes yet"
                : "No recordings yet"}
            </p>
          </div>
        ) : (
          <>
            {tab === "voice-notes"
              ? voiceNotes.items.map((item) => (
                  <VoiceNoteFeedItem
                    key={item.voice_note.id}
                    item={item}
                  />
                ))
              : recordings.items.map((item) => (
                  <RecordingFeedItem
                    key={item.recording.room_id}
                    item={item}
                  />
                ))}

            {activeFeed.hasMore && (
              <div className="px-4 py-4">
                <button
                  onClick={loadMore}
                  disabled={activeFeed.isLoading}
                  className="w-full rounded-full bg-white/10 py-2.5 text-xs font-medium text-white/60 transition-colors hover:bg-white/15 disabled:opacity-50"
                >
                  {activeFeed.isLoading ? "Loading..." : "Load more"}
                </button>
              </div>
            )}

            {activeFeed.error && activeFeed.items.length > 0 && (
              <p className="px-4 py-2 text-center text-xs text-red-400/60">
                {activeFeed.error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 px-4 py-3 text-xs font-medium tracking-wide transition-colors ${
        active
          ? "border-b-2 border-white text-white"
          : "border-b-2 border-transparent text-white/40 hover:text-white/70"
      }`}
    >
      {label}
    </button>
  );
}

function FeedSkeleton() {
  return (
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
  );
}
