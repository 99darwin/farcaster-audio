import type { Metadata } from "next";
import Link from "next/link";
import { JukeSpaceEmbed } from "@/components/juke-space-embed";
import { getSpaceDetail } from "@/lib/spaces";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const data = await getSpaceDetail(id);

  if (!data) {
    return {
      title: "Juke Space",
      description: "Listen to a live Juke space.",
    };
  }

  return {
    title: `${data.room.title} - Juke Embed`,
    description: `Hosted by ${data.room.host.display_name}. Listen live on Juke.`,
    robots: { index: false, follow: true },
  };
}

export default async function EmbedSpacePage({ params }: PageProps) {
  const { id } = await params;
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

  return <JukeSpaceEmbed spaceId={id} initialData={detail} />;
}
