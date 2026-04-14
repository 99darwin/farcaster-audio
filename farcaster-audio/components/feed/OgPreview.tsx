import { useEffect, useState } from "react";
import { View, Text, Pressable, Linking, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { colors } from "@/constants/theme";
import { useMiniAppStore } from "@/stores/miniappStore";
import { resolveMiniApp } from "@/services/manifest";
import { fetchSnap, getCachedSnap } from "@/services/snapClient";
import type { SnapResponse } from "@/types/snap";
import { SnapCard } from "@/components/feed/snap/SnapCard";
import type { NeynarEmbed } from "@/types/neynar";
import type { CastEmbedLocationContext } from "@/types/miniapp";

const MINIAPP_URL_PREFIXES = [
  "https://warpcast.com/~/mini-app/",
  "https://farcaster.com/~/mini-app/",
  "https://farcaster.xyz/miniapps/",
  "https://farcaster.xyz/~/mini-app/",
];

/** Get frame metadata — Neynar uses both `fc_frame` and `frame` keys */
function getFrameMeta(embed: NeynarEmbed): Record<string, unknown> | undefined {
  return embed.metadata?.fc_frame ?? (embed.metadata as any)?.frame;
}

function isIntermediaryMiniAppUrl(url: string): boolean {
  return MINIAPP_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function isMiniApp(embed: NeynarEmbed): boolean {
  if (getFrameMeta(embed)) return true;
  const url = embed.url ?? "";
  return isIntermediaryMiniAppUrl(url);
}

function getMiniAppUrl(embed: NeynarEmbed): string {
  const frame = getFrameMeta(embed);
  if (!frame) return embed.url ?? "";

  // Frames v2 / miniapp: button.action.url is the launch URL
  const button = frame.button as
    | { action?: { type?: string; url?: string } }
    | undefined;
  if (button?.action?.type === "launch_frame" && button.action.url) {
    return button.action.url;
  }

  // Neynar may also use `buttons` array
  const buttons = frame.buttons as
    | Array<{ action_type?: string; target?: string }>
    | undefined;
  if (buttons?.length) {
    const launchButton = buttons.find((b) => b.action_type === "launch_frame");
    if (launchButton?.target) return launchButton.target;
  }

  // Miniapp manifest fields that Neynar may inline
  if (typeof frame.homeUrl === "string" && frame.homeUrl) {
    return frame.homeUrl;
  }
  if (typeof frame.home_url === "string" && frame.home_url) {
    return frame.home_url;
  }

  // Some embeds use a top-level url field
  if (typeof frame.url === "string" && frame.url) {
    return frame.url;
  }

  // For intermediary URLs (farcaster.xyz/miniapps/...), try to derive the
  // actual miniapp domain from other frame fields like image or splash
  return embed.url ?? "";
}

/** Extract a domain hint from frame metadata (image URL, splash URL, etc.) */
function getFrameDomainHint(embed: NeynarEmbed): string | undefined {
  const frame = getFrameMeta(embed);
  if (!frame) return undefined;

  // Check image, splashImageUrl, iconUrl for a non-intermediary domain
  const candidates = [
    frame.image,
    frame.splashImageUrl,
    frame.splash_image_url,
    frame.iconUrl,
    frame.icon_url,
  ].filter(
    (v): v is string => typeof v === "string" && v.startsWith("https://"),
  );

  for (const url of candidates) {
    try {
      const host = new URL(url).hostname;
      // Skip intermediary domains
      if (
        host === "farcaster.xyz" ||
        host === "warpcast.com" ||
        host === "farcaster.com"
      )
        continue;
      return host;
    } catch {
      continue;
    }
  }

  return undefined;
}

function getOgImage(embed: NeynarEmbed): string | undefined {
  const frame = getFrameMeta(embed);
  const frameImage = frame?.image_url as string | undefined;
  if (frameImage) return frameImage;
  return embed.metadata?.html?.ogImage?.[0]?.url;
}

function getOgTitle(embed: NeynarEmbed): string | undefined {
  return embed.metadata?.html?.ogTitle;
}

function getOgDescription(embed: NeynarEmbed): string | undefined {
  return embed.metadata?.html?.ogDescription;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function isTwitterUrl(url: string): boolean {
  const domain = getDomain(url);
  return domain === "x.com" || domain === "twitter.com";
}

function getTwitterInfo(embed: NeynarEmbed): {
  author?: string;
  text?: string;
} {
  const oembed = embed.metadata?.html?.oembed;
  if (!oembed) return {};

  const author = oembed.author_name;

  // Extract tweet text from the blockquote HTML
  const blockquoteMatch = oembed.html?.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  let text: string | undefined;
  if (blockquoteMatch) {
    text = blockquoteMatch[1]
      .replace(/<br\s*\/?>/g, "\n")
      .replace(/<a[^>]*>(.*?)<\/a>/g, "$1")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\u2026/g, "...")
      .trim();
  }

  return { author, text };
}

interface OgPreviewProps {
  embed: NeynarEmbed;
  /** Cast context for miniapp location — pass hash + author for cast_embed context */
  castContext?: {
    hash: string;
    authorFid: number;
    authorUsername: string;
    text: string;
  };
}

export function OgPreview({ embed, castContext }: OgPreviewProps) {
  const url = embed.url;
  const openMiniApp = useMiniAppStore((s) => s.openMiniApp);

  // Snap detection: only for non-mini-app URLs with no existing frame metadata.
  // Seed from the session cache so scrolled-back-into-view cards render instantly.
  const canDetectSnap = !!url && !getFrameMeta(embed) && !isMiniApp(embed);
  const [snap, setSnap] = useState<SnapResponse | null>(() =>
    canDetectSnap && url ? getCachedSnap(url) : null,
  );

  useEffect(() => {
    if (!canDetectSnap || !url || snap) return;
    let cancelled = false;
    fetchSnap(url).then((result) => {
      if (!cancelled && result) setSnap(result);
    });
    return () => {
      cancelled = true;
    };
  }, [canDetectSnap, url, snap]);

  if (!url) return null;

  if (snap) {
    return <SnapCard url={url} response={snap} />;
  }

  const imageUrl = getOgImage(embed);
  const title = getOgTitle(embed);
  const description = getOgDescription(embed);
  const miniApp = isMiniApp(embed);

  const handlePress = async () => {
    if (miniApp) {
      const miniAppUrl = getMiniAppUrl(embed);
      try {
        const domainHint = getFrameDomainHint(embed);
        const resolved = await resolveMiniApp(miniAppUrl, domainHint);
        // Guard against invalid resolved URLs (e.g. about:blank from bad manifests)
        if (!resolved.launchUrl || !resolved.launchUrl.startsWith("https://")) {
          return;
        }
        const location: CastEmbedLocationContext | undefined = castContext
          ? {
              type: "cast_embed",
              embed: miniAppUrl,
              cast: {
                hash: castContext.hash,
                text: castContext.text,
                author: {
                  fid: castContext.authorFid,
                  username: castContext.authorUsername,
                },
              },
            }
          : undefined;
        openMiniApp({
          url: resolved.launchUrl,
          domain: resolved.domain,
          manifest: resolved.manifest,
          config: resolved.config,
          location,
        });
      } catch {
        // Fallback to external URL if resolution fails
        Linking.openURL(miniAppUrl);
      }
    } else {
      Linking.openURL(url);
    }
  };

  // X/Twitter: custom card using oembed data (X blocks OG scraping)
  if (isTwitterUrl(url)) {
    const { author, text: tweetText } = getTwitterInfo(embed);
    return (
      <Pressable onPress={handlePress} style={styles.twitterContainer}>
        <View style={styles.twitterHeader}>
          {author ? <Text style={styles.twitterHandle}>{author}</Text> : null}
          <Text style={styles.twitterLogo}>𝕏</Text>
        </View>
        {tweetText ? (
          <Text style={styles.twitterText} numberOfLines={6}>
            {tweetText}
          </Text>
        ) : null}
        <Text style={styles.twitterDomain}>View on X</Text>
      </Pressable>
    );
  }

  // No OG data at all — nothing to show (URL is already linkified in text)
  if (!imageUrl && !title && !description) return null;

  // Mini-app: show OG image as a prominent tappable card
  if (miniApp && imageUrl) {
    return (
      <Pressable onPress={handlePress} style={styles.miniAppContainer}>
        <Image
          source={{ uri: imageUrl }}
          style={styles.miniAppImage}
          contentFit="cover"
          transition={200}
        />
        {title ? (
          <View style={styles.miniAppLabel}>
            <Text style={styles.miniAppTitle} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.miniAppBadge}>Mini App</Text>
          </View>
        ) : null}
      </Pressable>
    );
  }

  // Standard OG preview card
  return (
    <Pressable onPress={handlePress} style={styles.container}>
      {imageUrl ? (
        <Image
          source={{ uri: imageUrl }}
          style={styles.ogImage}
          contentFit="cover"
          transition={200}
        />
      ) : null}
      <View style={styles.textContainer}>
        <Text style={styles.domain} numberOfLines={1}>
          {getDomain(url)}
        </Text>
        {title ? (
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
        ) : null}
        {description ? (
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.background.border,
    borderRadius: 12,
    overflow: "hidden",
  },
  ogImage: {
    width: "100%",
    aspectRatio: 1.91,
  },
  textContainer: {
    padding: 10,
    gap: 2,
  },
  domain: {
    color: colors.text.secondary,
    fontSize: 12,
  },
  title: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: "600",
  },
  description: {
    color: colors.text.secondary,
    fontSize: 13,
    lineHeight: 18,
  },
  // X/Twitter styles
  twitterContainer: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: colors.background.border,
    borderRadius: 12,
    padding: 12,
  },
  twitterHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 4,
  },
  twitterHandle: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: "600",
  },
  twitterText: {
    color: colors.text.body,
    fontSize: 14,
    lineHeight: 20,
  },
  twitterLogo: {
    fontSize: 18,
    color: colors.text.primary,
    fontWeight: "700",
  },
  twitterDomain: {
    color: colors.text.secondary,
    fontSize: 12,
    marginTop: 8,
  },
  // Mini-app styles
  miniAppContainer: {
    marginTop: 8,
    borderRadius: 12,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: colors.background.border,
  },
  miniAppImage: {
    width: "100%",
    aspectRatio: 1.91,
  },
  miniAppLabel: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 10,
  },
  miniAppTitle: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: "600",
    flex: 1,
    marginRight: 8,
  },
  miniAppBadge: {
    color: colors.purple,
    fontSize: 11,
    fontWeight: "600",
    borderWidth: 1,
    borderColor: colors.purple,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: "hidden",
  },
});
