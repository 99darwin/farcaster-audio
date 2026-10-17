"use client";

/**
 * Global search (Stream G) — mirrors mobile `app/search.tsx`.
 *
 * A single debounced query drives four result categories behind a TabBar:
 *   People | Casts | Channels | Mini Apps
 *
 * Only the active tab is fetched (each fetch is abortable), so switching tabs
 * or typing quickly never leaves stale in-flight requests racing to render.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar } from "@/components/ui/avatar";
import { CastCard } from "@/components/ui/cast-card";
import { EmptyState } from "@/components/ui/empty-state";
import { FeedList } from "@/components/ui/feed-list";
import { Spinner } from "@/components/ui/spinner";
import { TabBar, type TabItem } from "@/components/ui/tab-bar";
import { safeImageUrl } from "@/lib/safe-url";
import {
  identityCast,
  useCastListNavigation,
  type CastRowProps,
} from "@/lib/keyboard/useCastListNavigation";
import { useComposeStore } from "@/lib/stores/composeStore";
import {
  searchCasts,
  searchChannels,
  searchMiniapps,
  searchUsers,
  type ChannelSearchItem,
  type MiniappResult,
  type UserSearchItem,
} from "@/lib/api/search";
import type { Cast } from "@/lib/api/types";

type SearchTab = "people" | "casts" | "channels" | "miniapps";

const TABS: ReadonlyArray<TabItem<SearchTab>> = [
  { key: "people", label: "People" },
  { key: "casts", label: "Casts" },
  { key: "channels", label: "Channels" },
  { key: "miniapps", label: "Mini Apps" },
];

const DEBOUNCE_MS = 300;

/** Stable empty list so the keyboard hook no-ops on non-cast tabs. */
const NO_CASTS: Cast[] = [];

/** Debounce a rapidly-changing value. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

export default function SearchPage() {
  const router = useRouter();
  const openCompose = useComposeStore((s) => s.openCompose);
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<SearchTab>("people");

  const handlePressCast = useCallback(
    (cast: Cast) => router.push(`/app/cast/${cast.hash}`),
    [router],
  );

  const handleQuoteCast = useCallback(
    (cast: Cast) =>
      openCompose({
        mode: "quote",
        target: { hash: cast.hash, author: cast.author },
      }),
    [openCompose],
  );

  const [people, setPeople] = useState<UserSearchItem[]>([]);
  const [casts, setCasts] = useState<Cast[]>([]);
  const [channels, setChannels] = useState<ChannelSearchItem[]>([]);
  const [miniapps, setMiniapps] = useState<MiniappResult[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debouncedQuery = useDebounced(query.trim(), DEBOUNCE_MS);
  const abortRef = useRef<AbortController | null>(null);

  const runSearch = useCallback(
    async (tab: SearchTab, q: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      setLoading(true);
      setError(null);
      try {
        switch (tab) {
          case "people":
            setPeople(await searchUsers(q, { signal }));
            break;
          case "casts":
            setCasts(await searchCasts(q, { signal }));
            break;
          case "channels":
            setChannels(await searchChannels(q, { signal }));
            break;
          case "miniapps":
            setMiniapps(await searchMiniapps(q, { signal }));
            break;
        }
        if (!signal.aborted) setLoading(false);
      } catch (err) {
        if (isAbortError(err) || signal.aborted) return;
        setError("Something went wrong. Try again.");
        setLoading(false);
      }
    },
    [],
  );

  // Fetch whenever the debounced query or the active tab changes.
  useEffect(() => {
    if (!debouncedQuery) {
      abortRef.current?.abort();
      setLoading(false);
      return;
    }
    void runSearch(activeTab, debouncedQuery);
    return () => abortRef.current?.abort();
  }, [debouncedQuery, activeTab, runSearch]);

  const hasQuery = debouncedQuery.length > 0;

  // Feed keyboard navigation over the cast results. Only active on the Casts
  // tab; focus resets when the tab or query changes. Search cast cards expose
  // only open + quote, so j/k + Enter apply (no like/recast/reply/bookmark).
  const { focusedIndex, getRowProps } = useCastListNavigation({
    items: activeTab === "casts" ? casts : NO_CASTS,
    getCast: identityCast,
    onOpen: handlePressCast,
    resetKey: `${activeTab}:${debouncedQuery}`,
  });

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col">
      <div className="sticky top-0 z-10 bg-juke-navy/95 px-4 pb-2 pt-4 backdrop-blur">
        <label htmlFor="search-input" className="sr-only">
          Search Farcaster
        </label>
        <input
          id="search-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people, casts, channels, mini apps"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          className="w-full rounded-full border border-juke-border bg-juke-surface px-4 py-2.5 text-sm text-juke-text-on-dark placeholder:text-juke-text-on-dark-tertiary focus:border-juke-orange focus:outline-none"
        />
        <TabBar
          tabs={TABS}
          value={activeTab}
          onChange={setActiveTab}
          className="mt-3"
        />
      </div>

      <div
        role="tabpanel"
        aria-live="polite"
        className="flex-1"
      >
        {!hasQuery ? (
          <EmptyState
            title="Search Farcaster"
            description="Find people, casts, channels, and mini apps."
          />
        ) : error ? (
          <EmptyState title="Couldn't load results" description={error} />
        ) : loading && isActiveEmpty(activeTab, { people, casts, channels, miniapps }) ? (
          <div className="flex justify-center py-16">
            <Spinner />
          </div>
        ) : (
          <ResultsBody
            tab={activeTab}
            query={debouncedQuery}
            loading={loading}
            people={people}
            casts={casts}
            channels={channels}
            miniapps={miniapps}
            onPressCast={handlePressCast}
            onQuoteCast={handleQuoteCast}
            castFocusedIndex={focusedIndex}
            getCastRowProps={getRowProps}
          />
        )}
      </div>
    </div>
  );
}

function isActiveEmpty(
  tab: SearchTab,
  data: {
    people: UserSearchItem[];
    casts: Cast[];
    channels: ChannelSearchItem[];
    miniapps: MiniappResult[];
  },
): boolean {
  switch (tab) {
    case "people":
      return data.people.length === 0;
    case "casts":
      return data.casts.length === 0;
    case "channels":
      return data.channels.length === 0;
    case "miniapps":
      return data.miniapps.length === 0;
  }
}

interface ResultsBodyProps {
  tab: SearchTab;
  query: string;
  loading: boolean;
  people: UserSearchItem[];
  casts: Cast[];
  channels: ChannelSearchItem[];
  miniapps: MiniappResult[];
  onPressCast: (cast: Cast) => void;
  onQuoteCast: (cast: Cast) => void;
  /** -1 when no cast is focused. */
  castFocusedIndex: number;
  getCastRowProps: (index: number) => CastRowProps;
}

function ResultsBody({
  tab,
  query,
  loading,
  people,
  casts,
  channels,
  miniapps,
  onPressCast,
  onQuoteCast,
  castFocusedIndex,
  getCastRowProps,
}: ResultsBodyProps) {
  const empty = (label: string) => (
    <EmptyState title={`No ${label} found`} description={`Nothing matched "${query}".`} />
  );

  switch (tab) {
    case "people":
      return (
        <FeedList
          items={people}
          loading={loading}
          getKey={(u) => u.fid}
          emptyState={empty("people")}
          renderItem={(user) => <PersonRow user={user} />}
        />
      );
    case "casts":
      return (
        <FeedList
          items={casts}
          loading={loading}
          getKey={(c) => c.hash}
          emptyState={empty("casts")}
          renderItem={(cast, index) => (
            <div {...getCastRowProps(index)}>
              <CastCard
                cast={cast}
                focused={index === castFocusedIndex}
                onPress={onPressCast}
                onQuote={onQuoteCast}
              />
            </div>
          )}
        />
      );
    case "channels":
      return (
        <FeedList
          items={channels}
          loading={loading}
          getKey={(c) => c.id}
          emptyState={empty("channels")}
          renderItem={(channel) => <ChannelRow channel={channel} />}
        />
      );
    case "miniapps":
      return (
        <FeedList
          items={miniapps}
          loading={loading}
          getKey={(m, i) => `${m.frames_url}-${i}`}
          emptyState={empty("mini apps")}
          renderItem={(app) => <MiniappRow app={app} />}
        />
      );
  }
}

function PersonRow({ user }: { user: UserSearchItem }) {
  return (
    <Link
      href={`/app/profile/${user.fid}`}
      className="flex items-center gap-3 border-b border-juke-border px-4 py-3 transition-colors hover:bg-white/5"
    >
      <Avatar src={user.pfp_url} name={user.display_name || user.username} size="md" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-juke-text-on-dark">
          {user.display_name || user.username}
        </p>
        <p className="truncate text-xs text-juke-text-on-dark-secondary">
          @{user.username}
        </p>
        {user.bio ? (
          <p className="mt-0.5 truncate text-xs text-juke-text-on-dark-tertiary">
            {user.bio}
          </p>
        ) : null}
      </div>
    </Link>
  );
}

function ChannelRow({ channel }: { channel: ChannelSearchItem }) {
  const name = channel.name || channel.id;
  return (
    <Link
      href={`/app/channel/${encodeURIComponent(channel.id)}`}
      className="flex items-center gap-3 border-b border-juke-border px-4 py-3 transition-colors hover:bg-white/5"
    >
      <Avatar src={channel.image_url} name={name} size="md" className="rounded-lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-juke-text-on-dark">
          /{channel.id}
        </p>
        {channel.description ? (
          <p className="truncate text-xs text-juke-text-on-dark-secondary">
            {channel.description}
          </p>
        ) : null}
      </div>
    </Link>
  );
}

function MiniappRow({ app }: { app: MiniappResult }) {
  const href = safeImageUrl(app.frames_url); // https-only guard, reused for links
  const body = (
    <>
      <Avatar src={app.image_url} name={app.name} size="md" className="rounded-lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-juke-text-on-dark">
          {app.name}
        </p>
        {app.author?.username ? (
          <p className="truncate text-xs text-juke-text-on-dark-secondary">
            by @{app.author.username}
          </p>
        ) : null}
      </div>
    </>
  );

  const rowClass =
    "flex items-center gap-3 border-b border-juke-border px-4 py-3 transition-colors hover:bg-white/5";

  if (!href) {
    return <div className={rowClass}>{body}</div>;
  }

  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={rowClass}>
      {body}
    </a>
  );
}
