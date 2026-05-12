import { Metadata } from "next";
import { notFound } from "next/navigation";
import { WebPlayer } from "./web-player";
import {
  getVoiceNote,
  formatDuration,
  formatTimestamp,
  type VoiceNoteDetail,
} from "@/lib/voice-notes";

export { type VoiceNoteDetail };

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const data = await getVoiceNote(id);
  if (!data) return { title: "Voice Note — Juke" };

  const { voice_note, author } = data;
  const safeName = author.display_name.slice(0, 50);
  const title = `${safeName} on Juke`;
  const cleanTranscript = voice_note.transcript
    ? voice_note.transcript.replace(/https?:\/\/\S+/gi, "").trim()
    : null;
  const description = cleanTranscript
    ? cleanTranscript.slice(0, 160) +
      (cleanTranscript.length > 160 ? "..." : "")
    : `${formatDuration(voice_note.duration_ms)} voice note`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      images: [`/v/${id}/opengraph-image`],
      audio: voice_note.audio_url,
      type: "music.song",
      siteName: "Juke",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
    other: {
      "fc:miniapp": JSON.stringify({
        version: "1",
        imageUrl: `https://juke.audio/v/${id}/opengraph-image`,
        button: {
          title: "\u25B6 Play Voice Note",
          action: {
            type: "launch_miniapp",
            name: "Juke Audio",
            url: `https://juke.audio/miniapp/v/${id}`,
            splashImageUrl: "https://juke.audio/app-icon.png",
            splashBackgroundColor: "#6a3cff",
          },
        },
      }),
    },
  };
}

export default async function VoiceNotePage({ params }: PageProps) {
  const { id } = await params;
  const data = await getVoiceNote(id);
  if (!data) notFound();

  const { voice_note, author, reaction_counts, play_count } = data;

  return (
    <main className="min-h-screen bg-juke-navy">
      {/* Header */}
      <header className="border-b border-juke-border/30 px-6 py-4">
        <div className="mx-auto flex max-w-2xl items-center gap-2.5">
          <img
            src="/logomark.png"
            alt=""
            width={32}
            height={32}
            className="h-8 w-8 brightness-0 invert"
          />
          <a
            href="/"
            className="text-lg font-bold tracking-[0.15em] text-juke-text-on-dark transition-colors hover:text-white"
          >
            JUKE
          </a>
        </div>
      </header>

      {/* Player card */}
      <div className="mx-auto max-w-2xl px-6 py-10 sm:py-16">
        <div className="rounded-2xl border border-juke-border/40 bg-juke-surface p-6 sm:p-8">
          {/* Author row */}
          <div className="mb-6 flex items-center gap-3">
            {author.pfp_url ? (
              <img
                src={author.pfp_url}
                alt={author.display_name}
                width={48}
                height={48}
                className="h-12 w-12 rounded-full object-cover"
              />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-juke-border text-lg font-bold text-juke-text-on-dark">
                {author.display_name.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-juke-text-on-dark">
                {author.display_name}
              </p>
              <p className="truncate text-sm text-juke-text-on-dark-tertiary">
                @{author.username} &middot;{" "}
                {formatTimestamp(voice_note.created_at)}
              </p>
            </div>
          </div>

          {/* Caption */}
          {voice_note.caption && (
            <p className="mb-5 text-sm leading-relaxed text-juke-text-on-dark-secondary">
              {voice_note.caption}
            </p>
          )}

          {/* Interactive player (client component) */}
          <WebPlayer
            audioUrl={voice_note.audio_url}
            durationMs={voice_note.duration_ms}
            waveformPeaks={voice_note.waveform_peaks}
          />

          {/* Stats row */}
          <div className="mt-5 flex items-center gap-4 text-xs text-juke-text-on-dark-tertiary">
            {play_count > 0 && (
              <span>
                {play_count.toLocaleString()}{" "}
                {play_count === 1 ? "play" : "plays"}
              </span>
            )}
            {Object.entries(reaction_counts).map(([emoji, count]) => (
              <span key={emoji}>
                {emoji} {count}
              </span>
            ))}
          </div>

          {/* Transcript */}
          {voice_note.transcript && (
            <div className="mt-6 border-t border-juke-border/30 pt-5">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-juke-text-on-dark-tertiary">
                Transcript
              </p>
              <p className="text-sm leading-relaxed text-juke-text-on-dark-secondary">
                {voice_note.transcript}
              </p>
            </div>
          )}
        </div>

        {/* Open in Juke CTA */}
        <div className="mt-6 flex flex-col items-center gap-3">
          <a
            href={`juke://voice-note/${id}`}
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-juke-orange px-8 py-3.5 text-base font-bold text-white transition-colors hover:bg-juke-orange-hover focus-visible:ring-2 focus-visible:ring-juke-orange focus-visible:ring-offset-2 focus-visible:ring-offset-juke-navy sm:w-auto"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              className="h-5 w-5"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
              />
            </svg>
            Open in Juke
          </a>
          <p className="text-xs text-juke-text-on-dark-tertiary">
            Listen in the app for the full experience
          </p>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-juke-border/30 px-6 py-5">
        <div className="mx-auto flex max-w-2xl items-center justify-between text-sm text-juke-text-on-dark-tertiary">
          <span>&copy; 2026 Juke</span>
          <a
            href="https://farcaster.xyz/jukeaudio"
            target="_blank"
            rel="noopener noreferrer"
            className="transition-colors hover:text-juke-text-on-dark-secondary"
          >
            @jukeaudio on Farcaster
          </a>
        </div>
      </footer>
    </main>
  );
}
