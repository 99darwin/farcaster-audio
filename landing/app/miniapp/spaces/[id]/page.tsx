"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { use } from "react";
import sdk from "@farcaster/miniapp-sdk";
import { SpaceListener } from "@/components/space-listener";
import { getSpaceDetail, type SpaceDetailResponse } from "@/lib/spaces";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function SpacePage({ params }: PageProps) {
  const { id } = use(params);
  const [data, setData] = useState<SpaceDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError(null);
      try {
        const detail = await getSpaceDetail(id);
        if (cancelled) return;
        if (!detail) {
          setError("Space not found");
          return;
        }
        setData(detail);
      } catch {
        if (!cancelled) setError("Couldn't load space");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    sdk.actions.ready();

    return () => {
      cancelled = true;
    };
  }, [id]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col px-4 pt-6">
        <BackLink />
        <div className="mt-10 space-y-4">
          <div className="h-4 w-32 animate-pulse rounded bg-white/10" />
          <div className="h-6 w-3/4 animate-pulse rounded bg-white/10" />
          <div className="flex gap-2">
            <div className="h-12 w-12 animate-pulse rounded-full bg-white/10" />
            <div className="h-12 w-12 animate-pulse rounded-full bg-white/10" />
            <div className="h-12 w-12 animate-pulse rounded-full bg-white/10" />
          </div>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen flex-col px-4 pt-6">
        <BackLink />
        <div className="mt-20 flex flex-col items-center justify-center">
          <p className="mb-4 text-sm text-white/50">
            {error || "Space not found"}
          </p>
          <Link
            href="/miniapp"
            className="rounded-full bg-white/10 px-5 py-2 text-xs font-medium text-white/70 transition-colors hover:bg-white/15"
          >
            Back to feed
          </Link>
        </div>
      </div>
    );
  }

  return <SpaceListener spaceId={id} initialData={data} />;
}

function BackLink() {
  return (
    <Link
      href="/miniapp"
      className="flex items-center gap-1 self-start text-xs text-white/40 transition-colors hover:text-white/60"
    >
      <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
        <path
          fillRule="evenodd"
          d="M17 10a.75.75 0 01-.75.75H5.612l4.158 3.96a.75.75 0 11-1.04 1.08l-5.5-5.25a.75.75 0 010-1.08l5.5-5.25a.75.75 0 111.04 1.08L5.612 9.25H16.25A.75.75 0 0117 10z"
          clipRule="evenodd"
        />
      </svg>
      Feed
    </Link>
  );
}
