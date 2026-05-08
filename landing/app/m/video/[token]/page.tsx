import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { decodeVideoMedia } from "./media";

type PageProps = { params: Promise<{ token: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { token } = await params;
  const media = decodeVideoMedia(token);
  if (!media) return { title: "Video — Juke" };

  return {
    title: media.title,
    description: media.description,
    openGraph: {
      title: media.title,
      description: media.description,
      images: [media.posterUrl],
      siteName: "Juke",
      type: "video.other",
      videos: [
        {
          url: media.hlsUrl,
          secureUrl: media.hlsUrl,
          type: "application/x-mpegURL",
        },
        {
          url: media.mp4Url,
          secureUrl: media.mp4Url,
          type: "video/mp4",
        },
      ],
    },
    twitter: {
      card: "player",
      title: media.title,
      description: media.description,
      images: [media.posterUrl],
      players: {
        playerUrl: media.hlsUrl,
        streamUrl: media.hlsUrl,
        width: 720,
        height: 1280,
      },
    },
  };
}

export default async function VideoMediaPage({ params }: PageProps) {
  const { token } = await params;
  const media = decodeVideoMedia(token);
  if (!media) notFound();

  return (
    <main className="min-h-screen bg-black">
      <video
        src={media.hlsUrl}
        poster={media.posterUrl}
        controls
        playsInline
        preload="metadata"
        className="mx-auto h-screen max-h-screen w-full max-w-3xl bg-black object-contain"
      />
    </main>
  );
}
