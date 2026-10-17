import type { Metadata } from "next";
import { Bricolage_Grotesque } from "next/font/google";
import { connection } from "next/server";
import { ScrubbedAnalytics } from "@/components/scrubbed-analytics";
import "./globals.css";

const bricolage = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-bricolage",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Juke — Live Audio on Farcaster",
  description:
    "Host live audio spaces, browse your Farcaster feed, and chat in threads. Join the beta.",
  metadataBase: new URL("https://juke.audio"),
  icons: {
    apple: "/app-icon.png",
  },
  openGraph: {
    title: "Juke — Live Audio on Farcaster",
    description:
      "Host live audio spaces, browse your Farcaster feed, and chat in threads.",
    url: "https://juke.audio",
    siteName: "Juke",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Juke — Live Audio on Farcaster",
    description:
      "Host live audio spaces, browse your Farcaster feed, and chat in threads.",
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Render every page per request. The enforced CSP (middleware.ts) is
  // nonce-based, and Next.js only stamps the nonce on its inline scripts when
  // rendering dynamically — a prerendered page would ship nonce-less scripts
  // that the browser refuses to run. Origin-wide on purpose: auth tokens and
  // the auth-address key are readable by script on any same-origin page.
  await connection();
  return (
    <html lang="en" className={bricolage.variable}>
      <body className="font-sans antialiased">
        {children}
        <ScrubbedAnalytics />
      </body>
    </html>
  );
}
