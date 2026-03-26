import type { Metadata } from "next";
import "./globals.css";

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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
