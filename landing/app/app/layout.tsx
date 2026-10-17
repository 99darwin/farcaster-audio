import type { Metadata } from "next";
import { AppProviders } from "./providers";

export const metadata: Metadata = {
  title: "Juke",
  description: "Live audio spaces and voice notes for Farcaster.",
  openGraph: {
    title: "Juke",
    description: "Live audio spaces and voice notes for Farcaster.",
    images: ["https://juke.audio/miniapp-hero.png"],
    siteName: "Juke",
  },
};

/**
 * Server layout for the `/app` client shell. Keeps only metadata + the dark
 * brand wrapper here (no stores/hooks), delegating all interactive shell
 * concerns to the `AppProviders` client subtree so it can persist across
 * route changes.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-juke-navy text-juke-text-on-dark">
      <AppProviders>{children}</AppProviders>
    </div>
  );
}
