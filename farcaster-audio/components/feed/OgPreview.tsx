import { View, Text, Pressable, Linking, StyleSheet } from 'react-native';
import { Image } from 'expo-image';
import { colors } from '@/constants/theme';
import type { NeynarEmbed } from '@/types/neynar';

const WARPCAST_MINIAPP_PREFIX = 'https://warpcast.com/~/mini-app/';
const FARCASTER_MINIAPP_PREFIX = 'https://farcaster.com/~/mini-app/';

function isMiniApp(embed: NeynarEmbed): boolean {
  if (embed.metadata?.fc_frame) return true;
  const url = embed.url ?? '';
  return url.startsWith(WARPCAST_MINIAPP_PREFIX) || url.startsWith(FARCASTER_MINIAPP_PREFIX);
}

function getMiniAppUrl(embed: NeynarEmbed): string {
  const frameAction = embed.metadata?.fc_frame?.button?.action;
  if (frameAction?.type === 'launch_frame' && frameAction.url) {
    return frameAction.url;
  }
  return embed.url ?? '';
}

function getOgImage(embed: NeynarEmbed): string | undefined {
  const frameImage = embed.metadata?.fc_frame?.image_url;
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
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function isTwitterUrl(url: string): boolean {
  const domain = getDomain(url);
  return domain === 'x.com' || domain === 'twitter.com';
}

function getTwitterInfo(embed: NeynarEmbed): { author?: string; text?: string } {
  const oembed = embed.metadata?.html?.oembed;
  if (!oembed) return {};

  const author = oembed.author_name;

  // Extract tweet text from the blockquote HTML
  const blockquoteMatch = oembed.html?.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  let text: string | undefined;
  if (blockquoteMatch) {
    text = blockquoteMatch[1]
      .replace(/<br\s*\/?>/g, '\n')
      .replace(/<a[^>]*>(.*?)<\/a>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\u2026/g, '...')
      .trim();
  }

  return { author, text };
}

interface OgPreviewProps {
  embed: NeynarEmbed;
}

export function OgPreview({ embed }: OgPreviewProps) {
  const url = embed.url;
  if (!url) return null;

  const imageUrl = getOgImage(embed);
  const title = getOgTitle(embed);
  const description = getOgDescription(embed);
  const miniApp = isMiniApp(embed);

  const handlePress = () => {
    if (miniApp) {
      const miniAppUrl = getMiniAppUrl(embed);
      Linking.openURL(miniAppUrl);
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
          {author ? (
            <Text style={styles.twitterHandle}>{author}</Text>
          ) : null}
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
            <Text style={styles.miniAppTitle} numberOfLines={1}>{title}</Text>
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
    overflow: 'hidden',
  },
  ogImage: {
    width: '100%',
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
    fontWeight: '600',
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  twitterHandle: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '600',
  },
  twitterText: {
    color: colors.text.body,
    fontSize: 14,
    lineHeight: 20,
  },
  twitterLogo: {
    fontSize: 18,
    color: colors.text.primary,
    fontWeight: '700',
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
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: colors.background.border,
  },
  miniAppImage: {
    width: '100%',
    aspectRatio: 1.91,
  },
  miniAppLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 10,
  },
  miniAppTitle: {
    color: colors.text.primary,
    fontSize: 14,
    fontWeight: '600',
    flex: 1,
    marginRight: 8,
  },
  miniAppBadge: {
    color: colors.purple,
    fontSize: 11,
    fontWeight: '600',
    borderWidth: 1,
    borderColor: colors.purple,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
});
