"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  discoverMiniApps,
  type MiniAppCatalogItem,
  type MiniAppDiscoveryResponse,
} from "@/lib/api/miniapps";
import { safeImageUrl } from "@/lib/safe-url";
import { MiniAppBrowser } from "@/components/miniapp/MiniAppBrowser";
import { useMiniAppShell } from "@/components/miniapp/MiniAppShell";

const METRIC_LABELS: Readonly<Record<string, string>> = {
  opens: "opens",
  unique_users: "people",
  users: "people",
  adds: "saves",
  trending_score: "trend score",
};

const NUMBER_FORMATTER = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function mergeCatalog(
  current: MiniAppCatalogItem[],
  incoming: MiniAppCatalogItem[],
): MiniAppCatalogItem[] {
  const seen = new Set(current.map((item) => item.frames_url));
  const merged = [...current];
  for (const item of incoming) {
    if (seen.has(item.frames_url)) continue;
    seen.add(item.frames_url);
    merged.push(item);
  }
  return merged;
}

function metricSummary(app: MiniAppCatalogItem): string | null {
  if (!app.metrics) return null;
  const parts: string[] = [];
  for (const [key, label] of Object.entries(METRIC_LABELS)) {
    const value = app.metrics[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    parts.push(`${NUMBER_FORMATTER.format(value)} ${label}`);
    if (parts.length === 2) break;
  }
  return parts.length ? parts.join(" · ") : null;
}

function MiniAppArtwork({
  app,
  featured = false,
}: {
  app: MiniAppCatalogItem;
  featured?: boolean;
}) {
  const image = safeImageUrl(app.image_url);
  const size = featured ? "h-full min-h-44 w-full" : "h-16 w-16";
  if (image) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- mini-app image hosts are not known at build time
      <img
        src={image}
        alt=""
        loading={featured ? "eager" : "lazy"}
        referrerPolicy="no-referrer"
        className={`${size} shrink-0 rounded-2xl object-cover`}
      />
    );
  }
  return (
    <div
      aria-hidden
      className={`${size} flex shrink-0 items-center justify-center rounded-2xl bg-juke-purple/25 text-3xl font-bold text-purple-100`}
    >
      {app.name.trim().charAt(0).toUpperCase() || "✦"}
    </div>
  );
}

function AuthorLine({ app }: { app: MiniAppCatalogItem }) {
  const username =
    typeof app.author?.username === "string" ? app.author.username : null;
  const displayName =
    typeof app.author?.display_name === "string"
      ? app.author.display_name
      : username;
  const metric = metricSummary(app);

  return (
    <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-juke-text-on-dark-secondary">
      {displayName ? (
        <>
          <Avatar
            src={
              typeof app.author?.pfp_url === "string"
                ? app.author.pfp_url
                : null
            }
            name={displayName}
            size="xs"
          />
          <span className="truncate">@{username ?? displayName}</span>
        </>
      ) : (
        <span>Farcaster Mini App</span>
      )}
      {app.rank != null ? (
        <span className="shrink-0 text-juke-orange">#{app.rank}</span>
      ) : null}
      {metric ? <span className="truncate">· {metric}</span> : null}
    </div>
  );
}

function FeaturedMiniApp({
  app,
  onOpen,
}: {
  app: MiniAppCatalogItem;
  onOpen: (app: MiniAppCatalogItem) => void;
}) {
  return (
    <article className="relative overflow-hidden border-y border-juke-border bg-juke-surface/70 px-4 py-5 sm:rounded-[26px] sm:border sm:px-5">
      <div
        aria-hidden
        className="absolute -right-12 -top-16 h-44 w-44 rounded-full bg-juke-orange/15"
      />
      <div className="relative grid gap-5 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center">
        <div className="aspect-[16/9] overflow-hidden rounded-2xl sm:aspect-square">
          <MiniAppArtwork app={app} featured />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-juke-orange">
            First on the turntable
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-juke-text-on-dark sm:text-3xl">
            {app.name}
          </h2>
          {app.description ? (
            <p className="mt-2 line-clamp-3 text-sm leading-6 text-juke-text-on-dark-secondary">
              {app.description}
            </p>
          ) : null}
          <AuthorLine app={app} />
          <Button
            className="mt-5 min-h-11"
            onClick={() => onOpen(app)}
            aria-label={`Open ${app.name} mini app`}
          >
            Open mini app
          </Button>
        </div>
      </div>
    </article>
  );
}

function CatalogRow({
  app,
  onOpen,
}: {
  app: MiniAppCatalogItem;
  onOpen: (app: MiniAppCatalogItem) => void;
}) {
  return (
    <article className="flex items-center gap-3 py-4 [contain-intrinsic-size:92px] [content-visibility:auto] sm:gap-4">
      <MiniAppArtwork app={app} />
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-base font-bold text-juke-text-on-dark">
          {app.name}
        </h3>
        {app.description ? (
          <p className="mt-0.5 line-clamp-2 text-sm leading-5 text-juke-text-on-dark-secondary">
            {app.description}
          </p>
        ) : null}
        <AuthorLine app={app} />
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-11 shrink-0 px-4"
        onClick={() => onOpen(app)}
        aria-label={`Open ${app.name} mini app`}
      >
        Open
      </Button>
    </article>
  );
}

export default function MiniAppsPage() {
  const { status, signIn } = useAuth();
  const miniAppShell = useMiniAppShell();
  const [catalog, setCatalog] = useState<MiniAppCatalogItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [meta, setMeta] = useState<MiniAppDiscoveryResponse["meta"] | null>(
    null,
  );
  const [selected, setSelected] = useState<MiniAppCatalogItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const started = useRef(false);

  const openMiniApp = useCallback(
    (app: MiniAppCatalogItem) => {
      if (miniAppShell) {
        setSelected(null);
        miniAppShell.openMiniApp({
          launchUrl: app.frames_url,
          title: app.name,
        });
        return;
      }
      setSelected(app);
    },
    [miniAppShell],
  );

  const loadCatalog = useCallback(async (nextCursor: string | null = null) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await discoverMiniApps({
        limit: 24,
        cursor: nextCursor,
      });
      setCatalog((current) =>
        nextCursor
          ? mergeCatalog(current, response.frames)
          : response.frames,
      );
      setCursor(response.next.cursor);
      setMeta(response.meta);
    } catch {
      setError("The catalog missed a beat. Try it again.");
    } finally {
      inFlight.current = false;
      setLoading(false);
      setInitialized(true);
    }
  }, []);

  useEffect(() => {
    if (status !== "authenticated") {
      started.current = false;
      return;
    }
    if (started.current) return;
    started.current = true;
    void loadCatalog();
  }, [loadCatalog, status]);

  if (status === "loading") {
    return (
      <div className="flex justify-center py-24">
        <Spinner size="lg" label="Loading Mini Apps" />
      </div>
    );
  }

  if (status === "anonymous") {
    return (
      <EmptyState
        title="Mini Apps are inside"
        description="Connect Farcaster to browse and open the catalog without leaving Juke."
        action={<Button onClick={() => void signIn()}>Connect Farcaster</Button>}
      />
    );
  }

  const featured = catalog[0] ?? null;
  const rotation = catalog.slice(1);
  const emptyDescription = meta?.unsupported
    ? "This Neynar plan doesn’t expose the catalog yet. Search still works when it’s available."
    : "No catalog picks are available right now. Give it another spin.";

  return (
    <div className="mx-auto min-h-[70vh] w-full max-w-2xl">
      <header className="relative overflow-hidden px-4 pb-7 pt-7 sm:px-6 sm:pt-9">
        <div
          aria-hidden
          className="absolute -left-20 top-2 h-40 w-40 rounded-full bg-juke-purple/15"
        />
        <div className="relative">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-juke-orange">
            Mini Apps
          </p>
          <h1 className="mt-2 max-w-lg text-3xl font-bold tracking-[-0.03em] text-juke-text-on-dark sm:text-4xl">
            A little web, right inside Juke.
          </h1>
          <p className="mt-3 max-w-lg text-sm leading-6 text-juke-text-on-dark-secondary sm:text-base">
            Fresh picks from Farcaster’s catalog. Open one, move it around,
            and keep the conversation nearby.
          </p>
        </div>
      </header>

      {loading && !initialized ? (
        <div className="flex justify-center py-24">
          <Spinner size="lg" label="Loading the Mini App catalog" />
        </div>
      ) : error && catalog.length === 0 ? (
        <EmptyState
          title="The catalog is off-air"
          description={error}
          action={
            <Button variant="ghost" onClick={() => void loadCatalog()}>
              Try again
            </Button>
          }
        />
      ) : featured ? (
        <>
          <FeaturedMiniApp app={featured} onOpen={openMiniApp} />

          {rotation.length > 0 || cursor || error ? (
            <section
              aria-labelledby="rotation-title"
              className="px-4 pt-8 sm:px-6"
            >
              <div className="flex items-end justify-between gap-4 border-b border-juke-border pb-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-juke-orange">
                    Keep browsing
                  </p>
                  <h2
                    id="rotation-title"
                    className="mt-1 text-xl font-bold text-juke-text-on-dark"
                  >
                    In the rotation
                  </h2>
                </div>
                {meta?.source === "neynar" ? (
                  <p className="pb-0.5 text-xs text-juke-text-on-dark-tertiary">
                    Catalog by Neynar
                  </p>
                ) : null}
              </div>

              <div className="divide-y divide-juke-border">
                {rotation.map((app) => (
                  <CatalogRow
                    key={app.frames_url}
                    app={app}
                    onOpen={openMiniApp}
                  />
                ))}
              </div>

              {error ? (
                <div
                  role="alert"
                  className="my-4 flex items-center justify-between gap-3 rounded-2xl bg-red-400/10 px-4 py-3 text-sm text-red-100"
                >
                  <span>{error}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void loadCatalog(cursor)}
                  >
                    Retry
                  </Button>
                </div>
              ) : null}

              {cursor ? (
                <div className="flex justify-center py-7">
                  <Button
                    variant="ghost"
                    loading={loading}
                    onClick={() => void loadCatalog(cursor)}
                  >
                    Load more
                  </Button>
                </div>
              ) : null}
            </section>
          ) : null}
        </>
      ) : (
        <EmptyState
          title="Nothing in the rotation"
          description={emptyDescription}
          action={
            <Button variant="ghost" onClick={() => void loadCatalog()}>
              Refresh catalog
            </Button>
          }
        />
      )}

      {selected ? (
        <MiniAppBrowser
          launchUrl={selected.frames_url}
          title={selected.name}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </div>
  );
}
