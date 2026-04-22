import Link from "next/link";
import { getSpaceDetail } from "@/lib/spaces";
import { SpaceClient } from "./space-client";

interface PageProps {
  params: Promise<{ id: string }>;
}

/**
 * Server component entry for the miniapp space listener.
 *
 * Fetches the space detail at request time so the initial HTML already
 * contains the room metadata and participant list. This avoids the
 * blank-screen-then-skeleton flicker the old client-only version
 * produced and also means search/link-previews get the correct markup.
 */
export default async function SpacePage({ params }: PageProps) {
  const { id } = await params;
  const detail = await getSpaceDetail(id);

  if (!detail) {
    return (
      <div className="flex min-h-screen flex-col px-4 pt-6">
        <BackLink />
        <div className="mt-20 flex flex-col items-center justify-center">
          <p className="mb-4 text-sm text-white/50">Space not found</p>
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

  return <SpaceClient spaceId={id} initialData={detail} />;
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
