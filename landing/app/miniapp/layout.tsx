import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Juke — Voice Notes for Farcaster",
  description:
    "Record, share, and listen to voice notes on Farcaster.",
  openGraph: {
    title: "Juke — Voice Notes for Farcaster",
    description:
      "Record, share, and listen to voice notes on Farcaster.",
    images: ["https://juke.audio/miniapp-hero.png"],
    siteName: "Juke",
  },
  other: {
    "fc:miniapp": JSON.stringify({
      version: "1",
      imageUrl: "https://juke.audio/miniapp-hero.png",
      button: {
        title: "Listen Now",
        action: {
          type: "launch_frame",
          name: "Juke Audio",
          url: "https://juke.audio/miniapp",
          splashImageUrl: "https://juke.audio/app-icon.png",
          splashBackgroundColor: "#6a3cff",
        },
      },
    }),
  },
};

export default function MiniAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0f0f23] text-white">{children}</div>
  );
}
