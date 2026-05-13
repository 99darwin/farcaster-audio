import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import {
  searchCasts,
  searchChannels,
  searchMiniapps,
  searchUsers,
  type UserSearchItem,
} from "@/services/api";
import type {
  CastSearchMeta,
  ChannelSearchItem,
  MiniappResult,
} from "@/types/api";
import type { NeynarCast } from "@/types/neynar";

export type SearchTab = "top" | "people" | "casts" | "channels" | "miniapps";
export type CastSort = "popular" | "recent";

const DEBOUNCE_MS = 250;

export interface TopResults {
  users: UserSearchItem[];
  casts: NeynarCast[];
  channels: ChannelSearchItem[];
}

export interface SearchResults {
  top: TopResults;
  people: UserSearchItem[];
  casts: NeynarCast[];
  channels: ChannelSearchItem[];
  miniapps: MiniappResult[];
}

export interface SearchLoading {
  top: boolean;
  people: boolean;
  casts: boolean;
  channels: boolean;
  miniapps: boolean;
}

export interface SearchErrors {
  top: string | null;
  people: string | null;
  casts: string | null;
  channels: string | null;
  miniapps: string | null;
}

export interface SearchMeta {
  casts: CastSearchMeta | null;
  miniappsUnsupported: boolean;
}

const EMPTY_RESULTS: SearchResults = {
  top: { users: [], casts: [], channels: [] },
  people: [],
  casts: [],
  channels: [],
  miniapps: [],
};

const EMPTY_LOADING: SearchLoading = {
  top: false,
  people: false,
  casts: false,
  channels: false,
  miniapps: false,
};

const EMPTY_ERRORS: SearchErrors = {
  top: null,
  people: null,
  casts: null,
  channels: null,
  miniapps: null,
};

function isAbortError(err: unknown): boolean {
  if (axios.isCancel(err)) return true;
  if (err instanceof Error && err.name === "CanceledError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

/**
 * Owns query text, active tab, cast sort, and the per-tab results dictionary.
 * Fetches only the active tab (or the "top" overview) on query change.
 *
 * One AbortController per tab; aborts the previous request before issuing a new
 * one so a slow response from a stale keystroke cannot overwrite fresh data.
 */
export function useSearchQuery() {
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState<SearchTab>("top");
  const [castSort, setCastSort] = useState<CastSort>("popular");
  const [results, setResults] = useState<SearchResults>(EMPTY_RESULTS);
  const [isLoading, setIsLoading] = useState<SearchLoading>(EMPTY_LOADING);
  const [errors, setErrors] = useState<SearchErrors>(EMPTY_ERRORS);
  const [meta, setMeta] = useState<SearchMeta>({
    casts: null,
    miniappsUnsupported: false,
  });

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortersRef = useRef<Record<SearchTab, AbortController | null>>({
    top: null,
    people: null,
    casts: null,
    channels: null,
    miniapps: null,
  });
  // Tracks the last query string we fetched for each tab so we can skip
  // re-fetching when the user switches back to a tab that already has data.
  // Tracks the last (query, sort) for casts since sort changes invalidate it.
  const lastFetchKeyRef = useRef<Record<SearchTab, string>>({
    top: "",
    people: "",
    casts: "",
    channels: "",
    miniapps: "",
  });

  const abortTab = useCallback((tab: SearchTab) => {
    abortersRef.current[tab]?.abort();
    abortersRef.current[tab] = null;
  }, []);

  const abortAll = useCallback(() => {
    (Object.keys(abortersRef.current) as SearchTab[]).forEach(abortTab);
  }, [abortTab]);

  const setTabLoading = useCallback((tab: SearchTab, value: boolean) => {
    setIsLoading((prev) => ({ ...prev, [tab]: value }));
  }, []);

  const setTabError = useCallback((tab: SearchTab, value: string | null) => {
    setErrors((prev) => ({ ...prev, [tab]: value }));
  }, []);

  const fetchPeople = useCallback(
    async (q: string, limit = 20) => {
      abortTab("people");
      const controller = new AbortController();
      abortersRef.current.people = controller;
      setTabLoading("people", true);
      setTabError("people", null);
      try {
        const data = await searchUsers(q, limit, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setResults((prev) => ({ ...prev, people: data.users }));
        lastFetchKeyRef.current.people = q;
      } catch (err) {
        if (isAbortError(err)) return;
        setTabError("people", "Couldn't load people");
      } finally {
        if (!controller.signal.aborted) setTabLoading("people", false);
      }
    },
    [abortTab, setTabError, setTabLoading],
  );

  const fetchChannels = useCallback(
    async (q: string, limit = 20) => {
      abortTab("channels");
      const controller = new AbortController();
      abortersRef.current.channels = controller;
      setTabLoading("channels", true);
      setTabError("channels", null);
      try {
        const data = await searchChannels(q, limit, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setResults((prev) => ({ ...prev, channels: data.channels }));
        lastFetchKeyRef.current.channels = q;
      } catch (err) {
        if (isAbortError(err)) return;
        setTabError("channels", "Couldn't load channels");
      } finally {
        if (!controller.signal.aborted) setTabLoading("channels", false);
      }
    },
    [abortTab, setTabError, setTabLoading],
  );

  const fetchMiniapps = useCallback(
    async (q: string) => {
      abortTab("miniapps");
      const controller = new AbortController();
      abortersRef.current.miniapps = controller;
      setTabLoading("miniapps", true);
      setTabError("miniapps", null);
      try {
        const data = await searchMiniapps(q, undefined, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setResults((prev) => ({ ...prev, miniapps: data.frames }));
        setMeta((prev) => ({
          ...prev,
          miniappsUnsupported: data.meta?.unsupported === true,
        }));
        lastFetchKeyRef.current.miniapps = q;
      } catch (err) {
        if (isAbortError(err)) return;
        setTabError("miniapps", "Couldn't load miniapps");
      } finally {
        if (!controller.signal.aborted) setTabLoading("miniapps", false);
      }
    },
    [abortTab, setTabError, setTabLoading],
  );

  const fetchTop = useCallback(
    async (q: string) => {
      abortTab("top");
      const controller = new AbortController();
      abortersRef.current.top = controller;
      setTabLoading("top", true);
      setTabError("top", null);
      try {
        const [usersRes, castsRes, channelsRes] = await Promise.all([
          searchUsers(q, 3, { signal: controller.signal }).catch((err) => {
            if (isAbortError(err)) throw err;
            return { users: [] as UserSearchItem[] };
          }),
          searchCasts(q, "popular", undefined, {
            signal: controller.signal,
            limit: 3,
          }).catch((err) => {
            if (isAbortError(err)) throw err;
            return {
              casts: [] as NeynarCast[],
              next: { cursor: null },
              meta: {
                parsed: {
                  author_username: null,
                  author_fid: null,
                  before: null,
                  after: null,
                  text: q,
                },
                unknown_author: false,
              },
            };
          }),
          searchChannels(q, 3, { signal: controller.signal }).catch((err) => {
            if (isAbortError(err)) throw err;
            return { channels: [] as ChannelSearchItem[] };
          }),
        ]);
        if (controller.signal.aborted) return;
        setResults((prev) => ({
          ...prev,
          top: {
            users: usersRes.users,
            casts: castsRes.casts,
            channels: channelsRes.channels,
          },
        }));
        lastFetchKeyRef.current.top = q;
      } catch (err) {
        if (isAbortError(err)) return;
        setTabError("top", "Couldn't load results");
      } finally {
        if (!controller.signal.aborted) setTabLoading("top", false);
      }
    },
    [abortTab, setTabError, setTabLoading],
  );

  const runFetchForTab = useCallback(
    (tab: SearchTab, q: string) => {
      if (!q) return;
      switch (tab) {
        case "top":
          fetchTop(q);
          break;
        case "people":
          fetchPeople(q);
          break;
        case "casts":
          // The materialized casts list is owned by `useSearchCasts`. We don't
          // duplicate the request here.
          break;
        case "channels":
          fetchChannels(q);
          break;
        case "miniapps":
          fetchMiniapps(q);
          break;
      }
    },
    [fetchChannels, fetchMiniapps, fetchPeople, fetchTop],
  );

  // Debounced fetch on query change for the active tab only.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const q = query.trim();
    if (!q) {
      abortAll();
      setResults(EMPTY_RESULTS);
      setIsLoading(EMPTY_LOADING);
      setErrors(EMPTY_ERRORS);
      setMeta({ casts: null, miniappsUnsupported: false });
      lastFetchKeyRef.current = {
        top: "",
        people: "",
        casts: "",
        channels: "",
        miniapps: "",
      };
      return;
    }

    debounceRef.current = setTimeout(() => {
      runFetchForTab(activeTab, q);
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // We intentionally exclude `activeTab` and `castSort` here — those have their
    // own effects below so a tab switch doesn't restart the debounce timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  // Tab switches: fire the new tab's fetch if its cached key doesn't match
  // the current (query [, sort]) tuple.
  useEffect(() => {
    const q = query.trim();
    if (!q) return;
    const expectedKey = activeTab === "casts" ? `${q}::${castSort}` : q;
    if (lastFetchKeyRef.current[activeTab] === expectedKey) return;
    runFetchForTab(activeTab, q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Cast-sort changes are handled by the dedicated `useSearchCasts` hook in the
  // Casts tab. No-op here.

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      abortAll();
    };
  }, [abortAll]);

  const value = useMemo(
    () => ({
      query,
      setQuery,
      activeTab,
      setActiveTab,
      castSort,
      setCastSort,
      results,
      isLoading,
      errors,
      meta,
    }),
    [activeTab, castSort, errors, isLoading, meta, query, results],
  );

  return value;
}
