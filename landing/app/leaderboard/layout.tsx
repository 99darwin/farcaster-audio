import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Leaderboard — Juke",
  description:
    "The people making Juke louder every month — Top Hosts, Top Voices, Top Casters, and Community. Status, badges, and a spotlight.",
  openGraph: {
    title: "Leaderboard — Juke",
    description:
      "The people making Juke louder every month — Top Hosts, Top Voices, Top Casters, and Community.",
    url: "https://juke.audio/leaderboard",
    siteName: "Juke",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Leaderboard — Juke",
    description:
      "The people making Juke louder every month — Top Hosts, Top Voices, Top Casters, and Community.",
  },
};

export default function LeaderboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
