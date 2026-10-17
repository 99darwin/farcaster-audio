import type { Metadata } from "next";
import Link from "next/link";
import { JukeSpaceEmbed } from "@/components/juke-space-embed";
import { getSpaceDetail } from "@/lib/spaces";

// Never put the embed URL (which may still carry a deprecated `?token=`
// partner JWT before the client strips it) in a Referer header.
const EMBED_REFERRER_POLICY = "strict-origin";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({
  params,
}: Pick<PageProps, "params">): Promise<Metadata> {
  const { id } = await params;
  const data = await getSpaceDetail(id);

  if (!data) {
    return {
      title: "Juke Space",
      description: "Listen to a live Juke space.",
      referrer: EMBED_REFERRER_POLICY,
    };
  }

  return {
    title: `${data.room.title} - Juke Embed`,
    description: `Hosted by ${data.room.host.display_name}. Listen live on Juke.`,
    robots: { index: false, follow: true },
    referrer: EMBED_REFERRER_POLICY,
  };
}

export default async function EmbedSpacePage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const search = await searchParams;
  const audioParam = Array.isArray(search.audio) ? search.audio[0] : search.audio;
  const audioMode: "on" | "off" = audioParam === "off" ? "off" : "on";
  // Partner SSO bridge: a developer app may pre-mint a short-lived Juke
  // JWT via POST /v1/developer/partner-tokens and pass it on the embed
  // URL — recommended as `#token=` (read client-side, never sent here);
  // the `?token=` query read below is deprecated but still honored. The
  // embed adopts the session client-side and skips sign-in. The backend
  // re-verifies the JWT on every authed call, so a malformed/expired
  // token still fails safely at join time.
  const tokenParam = Array.isArray(search.token) ? search.token[0] : search.token;
  const partnerToken = typeof tokenParam === "string" && tokenParam.length > 0
    ? tokenParam
    : undefined;
  const detail = await getSpaceDetail(id);

  if (!detail) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#0f0f23] px-5 text-white">
        <div className="max-w-sm text-center">
          <img
            src="/logomark.png"
            alt=""
            width={44}
            height={44}
            className="mx-auto mb-5 h-11 w-11"
          />
          <h1 className="text-2xl font-black">Space not found</h1>
          <p className="mt-2 text-sm leading-relaxed text-white/50">
            This Juke space is unavailable or has already ended.
          </p>
          <Link
            href="https://juke.audio"
            className="mt-6 inline-flex rounded-full bg-[#D85A30] px-5 py-3 text-sm font-black text-white"
          >
            Powered by Juke
          </Link>
        </div>
      </main>
    );
  }

  return (
    <JukeSpaceEmbed
      spaceId={id}
      initialData={detail}
      audioMode={audioMode}
      partnerToken={partnerToken}
    />
  );
}
