"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/components/ui/cn";
import { useAuth } from "@/lib/auth/AuthProvider";
import { ApiFetchError } from "@/lib/api/client";
import {
  cancelScheduledCast,
  getScheduledCasts,
  type ScheduledCast,
  type ScheduledCastStatus,
} from "@/lib/api/scheduled-casts";

type View = "upcoming" | "history";

const ACTIVE_STATUSES = new Set<ScheduledCastStatus>([
  "pending",
  "processing",
  "retrying",
]);

const STATUS_STYLES: Record<ScheduledCastStatus, string> = {
  pending: "bg-juke-orange/15 text-orange-200",
  processing: "bg-juke-purple/20 text-purple-200",
  retrying: "bg-amber-400/15 text-amber-200",
  published: "bg-emerald-400/15 text-emerald-200",
  failed: "bg-red-400/15 text-red-200",
  cancelled: "bg-white/10 text-juke-text-on-dark-secondary",
};

const ABSOLUTE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function parseTimestamp(value: string): Date | null {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function absoluteTime(value: string): string {
  const date = parseTimestamp(value);
  return date ? ABSOLUTE_FORMATTER.format(date) : "Time unavailable";
}

function relativeTime(value: string, now: number): string {
  const date = parseTimestamp(value);
  if (!date) return "Time unavailable";
  const delta = date.getTime() - now;
  const absolute = Math.abs(delta);
  if (absolute < 60_000) return delta >= 0 ? "In less than a minute" : "Due now";

  const units: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [24 * 60 * 60 * 1_000, "day"],
    [60 * 60 * 1_000, "hour"],
    [60 * 1_000, "minute"],
  ];
  const [size, unit] = units.find(([candidate]) => absolute >= candidate) ?? units[2];
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
    Math.round(delta / size),
    unit,
  );
}

function ClockMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export default function ScheduledCastsPage() {
  const { status, signIn } = useAuth();
  const [view, setView] = useState<View>("upcoming");
  const [jobs, setJobs] = useState<ScheduledCast[]>([]);
  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requestVersion = useRef(0);

  const load = useCallback(async (nextView: View) => {
    const version = ++requestVersion.current;
    setLoading(true);
    setError(null);
    setCancelError(null);
    try {
      const response = await getScheduledCasts({
        limit: 50,
        includeHistory: nextView === "history",
      });
      if (version !== requestVersion.current) return;
      const visible =
        nextView === "history"
          ? response.filter((job) => !ACTIVE_STATUSES.has(job.status))
          : response;
      setJobs(visible);
    } catch {
      if (version === requestVersion.current) {
        setError("Couldn’t load your scheduled casts. Please try again.");
      }
    } finally {
      if (version === requestVersion.current) {
        setLoading(false);
        setInitialized(true);
      }
    }
  }, []);

  useEffect(() => {
    if (status !== "authenticated") return;
    setInitialized(false);
    setJobs([]);
    setConfirmingId(null);
    void load(view);
  }, [load, status, view]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const handleCancel = useCallback(
    async (id: string) => {
      if (cancellingId) return;
      setCancellingId(id);
      setCancelError(null);
      try {
        await cancelScheduledCast(id);
        setConfirmingId(null);
        await load(view);
      } catch (caught) {
        const message =
          caught instanceof ApiFetchError && caught.status === 409
            ? "This cast is already publishing and can’t be cancelled."
            : "Couldn’t cancel this cast. It is still scheduled.";
        setCancelError(message);
      } finally {
        setCancellingId(null);
      }
    },
    [cancellingId, load, view],
  );

  if (status === "loading") {
    return (
      <div className="flex justify-center py-20">
        <Spinner size="lg" label="Loading scheduled casts" />
      </div>
    );
  }

  if (status === "anonymous") {
    return (
      <EmptyState
        title="Sign in to plan ahead"
        description="Schedule casts, replies, quotes, and media for the right moment."
        icon={<ClockMark className="h-12 w-12" />}
        action={<Button onClick={() => void signIn()}>Connect Farcaster</Button>}
      />
    );
  }

  return (
    <div className="min-h-[70vh]">
      <header className="border-b border-juke-border px-4 pb-0 pt-5 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.16em] text-juke-orange">
              Your queue
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-juke-text-on-dark">
              Scheduled
            </h1>
            <p className="mt-1 max-w-md text-sm text-juke-text-on-dark-secondary">
              Line up a thought now. Juke will cast it at your local time.
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load(view)}
            disabled={loading}
            aria-label="Refresh scheduled casts"
          >
            Refresh
          </Button>
        </div>

        <div role="tablist" aria-label="Scheduled cast views" className="mt-5 flex gap-6">
          {(["upcoming", "history"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              aria-selected={view === item}
              onClick={() => setView(item)}
              className={cn(
                "relative pb-3 text-sm font-semibold capitalize transition-colors",
                view === item
                  ? "text-juke-text-on-dark after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-juke-orange"
                  : "text-juke-text-on-dark-secondary hover:text-juke-text-on-dark",
              )}
            >
              {item}
            </button>
          ))}
        </div>
      </header>

      {cancelError && (
        <p role="alert" className="mx-4 mt-4 rounded-xl bg-red-400/10 px-3 py-2 text-sm text-red-200 sm:mx-6">
          {cancelError}
        </p>
      )}

      {loading && !initialized ? (
        <div className="flex justify-center py-20">
          <Spinner size="lg" label={`Loading ${view}`} />
        </div>
      ) : error && jobs.length === 0 ? (
        <EmptyState
          title="The queue is out of reach"
          description={error}
          action={
            <Button variant="ghost" onClick={() => void load(view)}>
              Try again
            </Button>
          }
        />
      ) : jobs.length === 0 ? (
        <EmptyState
          title={view === "upcoming" ? "Nothing queued yet" : "No history yet"}
          description={
            view === "upcoming"
              ? "Open any composer, choose Schedule, and pick your moment."
              : "Published and cancelled scheduled casts will settle here."
          }
          icon={<ClockMark className="h-12 w-12" />}
        />
      ) : (
        <div aria-busy={loading} className="divide-y divide-juke-border">
          {jobs.map((job) => {
            const canCancel = job.status === "pending" || job.status === "retrying";
            const confirming = confirmingId === job.id;
            const timeContext =
              job.status === "processing"
                ? "Publishing now"
                : job.status === "retrying"
                  ? `Retry ${relativeTime(job.next_attempt_at, now)}`
                  : relativeTime(job.scheduled_for, now);

            return (
              <article key={job.id} className="px-4 py-5 sm:px-6">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-juke-orange/10 text-juke-orange">
                    <ClockMark className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-bold capitalize", STATUS_STYLES[job.status])}>
                        {job.status}
                      </span>
                      <span className="text-xs font-semibold text-juke-text-on-dark-secondary">
                        {timeContext}
                      </span>
                    </div>

                    <p className="mt-2 whitespace-pre-wrap break-words text-[15px] leading-6 text-juke-text-on-dark">
                      {job.text || (job.embeds.length > 0 ? "Media post" : "Quote cast")}
                    </p>

                    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-juke-text-on-dark-secondary">
                      <time dateTime={job.scheduled_for}>{absoluteTime(job.scheduled_for)}</time>
                      {job.embeds.length > 0 && (
                        <span>{job.embeds.length} media {job.embeds.length === 1 ? "item" : "items"}</span>
                      )}
                      {job.parent && <span>Reply</span>}
                      {job.quote && <span>Quote</span>}
                      {job.channel_id && <span>/{job.channel_id}</span>}
                      {job.attempts > 0 && <span>{job.attempts} {job.attempts === 1 ? "attempt" : "attempts"}</span>}
                    </div>

                    {job.last_error && (
                      <p className="mt-2 rounded-lg bg-amber-300/10 px-2.5 py-2 text-xs leading-5 text-amber-100">
                        Last attempt: {job.last_error}
                      </p>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {job.published_hash && (
                        <Link
                          href={`/app/cast/${encodeURIComponent(job.published_hash)}`}
                          className="text-xs font-semibold text-juke-orange hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange"
                        >
                          View cast
                        </Link>
                      )}
                      {canCancel && !confirming && (
                        <button
                          type="button"
                          onClick={() => {
                            setConfirmingId(job.id);
                            setCancelError(null);
                          }}
                          className="text-xs font-semibold text-juke-text-on-dark-secondary hover:text-red-200 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange"
                        >
                          Cancel
                        </button>
                      )}
                      {confirming && (
                        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm cancellation">
                          <span className="text-xs text-red-200">Cancel this scheduled cast?</span>
                          <Button
                            variant="danger"
                            size="sm"
                            loading={cancellingId === job.id}
                            onClick={() => void handleCancel(job.id)}
                          >
                            Yes, cancel
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={cancellingId === job.id}
                            onClick={() => setConfirmingId(null)}
                          >
                            Keep it
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
