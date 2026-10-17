import { useEffect, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { Image } from "expo-image";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { useMiniAppStore } from "@/stores/miniappStore";
import { resolveMiniApp } from "@/services/manifest";
import { fetchSnap, getCachedSnap } from "@/services/snapClient";
import { getVoiceNote } from "@/services/voiceNotes";
import type { SnapResponse } from "@/types/snap";
import type { VoiceNoteDetail } from "@/types/voiceNote";
import { SnapCard } from "@/components/feed/snap/SnapCard";
import { VoiceNotePlayer } from "@/components/voice-notes/VoiceNotePlayer";
import { FarcasterSpaceEmbedCard } from "@/components/feed/FarcasterSpaceEmbedCard";
import { parseFarcasterSpaceUrl } from "@/services/parseSpaceUrl";
import type { FarcasterEmbed } from "@/types/farcaster";
import type { CastEmbedLocationContext } from "@/types/miniapp";
import { openSafeExternalUrl } from "@/utils/externalLinks";
import { isValidMiniAppUrl } from "@/utils/url";

const MINIAPP_URL_PREFIXES = [
  "https://warpcast.com/~/mini-app/",
  "https://farcaster.com/~/mini-app/",
  "https://farcaster.xyz/miniapps/",
  "https://farcaster.xyz/~/mini-app/",
];

/** Get frame metadata — the API uses both `fc_frame` and `frame` keys */
function getFrameMeta(
  embed: FarcasterEmbed,
): Record<string, unknown> | undefined {
  return embed.metadata?.fc_frame ?? (embed.metadata as any)?.frame;
}

function isIntermediaryMiniAppUrl(url: string): boolean {
  return MINIAPP_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function isMiniApp(embed: FarcasterEmbed): boolean {
  if (getFrameMeta(embed)) return true;
  const url = embed.url ?? "";
  return isIntermediaryMiniAppUrl(url);
}

function getMiniAppUrl(embed: FarcasterEmbed): string {
  const frame = getFrameMeta(embed);
  if (!frame) return embed.url ?? "";

  // Frames v2 / miniapp: button.action.url is the launch URL
  const button = frame.button as
    | { action?: { type?: string; url?: string } }
    | undefined;
  if (button?.action?.type === "launch_frame" && button.action.url) {
    return button.action.url;
  }

  // The API may also use `buttons` array
  const buttons = frame.buttons as
    | Array<{ action_type?: string; target?: string }>
    | undefined;
  if (buttons?.length) {
    const launchButton = buttons.find((b) => b.action_type === "launch_frame");
    if (launchButton?.target) return launchButton.target;
  }

  // Miniapp manifest fields that the API may inline
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
function getFrameDomainHint(embed: FarcasterEmbed): string | undefined {
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

function getOgImage(embed: FarcasterEmbed): string | undefined {
  const frame = getFrameMeta(embed);
  const frameImage = frame?.image_url as string | undefined;
  if (frameImage) return frameImage;
  return embed.metadata?.html?.ogImage?.[0]?.url;
}

function getOgTitle(embed: FarcasterEmbed): string | undefined {
  return embed.metadata?.html?.ogTitle;
}

function getOgDescription(embed: FarcasterEmbed): string | undefined {
  return embed.metadata?.html?.ogDescription;
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Match juke.audio/v/{uuid} URLs — these are our own voice note embeds */
const JUKE_VN_PATTERN =
  /^https?:\/\/(?:www\.)?juke\.audio\/v\/([0-9a-f-]{36})$/i;

function getJukeVoiceNoteId(url: string): string | null {
  const match = url.match(JUKE_VN_PATTERN);
  return match ? match[1] : null;
}

function isTwitterUrl(url: string): boolean {
  const domain = getDomain(url);
  return domain === "x.com" || domain === "twitter.com";
}

function getTwitterInfo(embed: FarcasterEmbed): {
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
  embed: FarcasterEmbed;
  /** Cast context for miniapp location — pass hash + author for cast_embed context */
  castContext?: {
    hash: string;
    authorFid: number;
    authorUsername: string;
    text: string;
  };
}

export function OgPreview({ embed, castContext }: OgPreviewProps) {
  const styles = useStyles();
  const url = embed.url;
  const openMiniApp = useMiniAppStore((s) => s.openMiniApp);

  // Detect Farcaster-native audio space embeds. The strict UUID gate in
  // `parseFarcasterSpaceUrl` keeps arbitrary embed URLs out of the
  // in-Juke navigation path. When the embed card's lookup turns up
  // nothing (no room, no bearer, network failure) it signals back and
  // we render the generic OG preview below as a graceful fallback.
  const farcasterSpace = url ? parseFarcasterSpaceUrl(url) : null;
  const [farcasterSpaceFallback, setFarcasterSpaceFallback] = useState(false);

  // Detect our own voice note embeds and render natively
  const voiceNoteId = url ? getJukeVoiceNoteId(url) : null;
  const [vnDetail, setVnDetail] = useState<VoiceNoteDetail | null>(null);

  useEffect(() => {
    if (!voiceNoteId) return;
    let cancelled = false;
    getVoiceNote(voiceNoteId)
      .then((detail) => {
        if (!cancelled) setVnDetail(detail);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [voiceNoteId]);

  // Snap detection: only for non-mini-app URLs with no existing frame metadata.
  // Seed from the session cache so scrolled-back-into-view cards render instantly.
  // NOTE: these hooks MUST stay above all conditional returns below —
  // otherwise the FarcasterSpaceEmbedCard fallback path (which mutates
  // state mid-render via onFallback) will change the hook count between
  // renders and trip React's rules-of-hooks check.
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

  if (voiceNoteId && vnDetail) {
    return (
      <View style={styles.voiceNoteEmbed}>
        <VoiceNotePlayer voiceNote={vnDetail.voice_note} variant="compact" />
      </View>
    );
  }

  // If it's a Juke URL but still loading, show nothing (avoid miniapp card flash)
  if (voiceNoteId) return null;

  // Farcaster-native audio space embed. The card resolves the room
  // snapshot on mount; if that resolution fails it triggers
  // `onFallback`, which flips `farcasterSpaceFallback` and lets the
  // generic OG card render instead on the next pass.
  if (farcasterSpace && !farcasterSpaceFallback) {
    return (
      <FarcasterSpaceEmbedCard
        spaceId={farcasterSpace.id}
        onFallback={() => setFarcasterSpaceFallback(true)}
      />
    );
  }

  if (!url) return null;

  if (snap) {
    return (
      <SnapCard
        url={url}
        response={snap}
        castContext={
          castContext
            ? { hash: castContext.hash, authorFid: castContext.authorFid }
            : undefined
        }
      />
    );
  }

  const imageUrl = getOgImage(embed);
  const title = getOgTitle(embed);
  const description = getOgDescription(embed);
  const miniApp = isMiniApp(embed);

  const handlePress = async () => {
    if (miniApp) {
      const miniAppUrl = getMiniAppUrl(embed);
      // Embed metadata is author-controlled; refuse anything that is not a
      // public https URL before resolving it or handing it to the OS.
      if (!isValidMiniAppUrl(miniAppUrl)) return;
      try {
        const domainHint = getFrameDomainHint(embed);
        const resolved = await resolveMiniApp(miniAppUrl, domainHint);
        // Guard against invalid resolved URLs (e.g. about:blank from bad manifests)
        if (!isValidMiniAppUrl(resolved.launchUrl)) return;
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
        await openSafeExternalUrl(miniAppUrl);
      }
    } else {
      await openSafeExternalUrl(url);
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

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      marginTop: 8,
      borderWidth: 1,
      borderColor: colors.background.border,
      borderRadius: 12,
      overflow: "hidden" as const,
    },
    ogImage: {
      width: "100%" as const,
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
      fontWeight: "600" as const,
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
      flexDirection: "row" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      marginBottom: 4,
    },
    twitterHandle: {
      color: colors.text.primary,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    twitterText: {
      color: colors.text.body,
      fontSize: 14,
      lineHeight: 20,
    },
    twitterLogo: {
      fontSize: 18,
      color: colors.text.primary,
      fontWeight: "700" as const,
    },
    twitterDomain: {
      color: colors.text.secondary,
      fontSize: 12,
      marginTop: 8,
    },
    // Native voice note embed
    voiceNoteEmbed: {
      marginTop: 8,
      borderWidth: 1,
      borderColor: colors.background.border,
      borderRadius: 12,
      padding: 12,
      overflow: "hidden" as const,
    },
    // Mini-app styles
    miniAppContainer: {
      marginTop: 8,
      borderRadius: 12,
      overflow: "hidden" as const,
      borderWidth: 1,
      borderColor: colors.background.border,
    },
    miniAppImage: {
      width: "100%" as const,
      aspectRatio: 1.91,
    },
    miniAppLabel: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
      padding: 10,
    },
    miniAppTitle: {
      color: colors.text.primary,
      fontSize: 14,
      fontWeight: "600" as const,
      flex: 1,
      marginRight: 8,
    },
    miniAppBadge: {
      color: colors.purple,
      fontSize: 11,
      fontWeight: "600" as const,
      borderWidth: 1,
      borderColor: colors.purple,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      overflow: "hidden" as const,
    },
  }));
