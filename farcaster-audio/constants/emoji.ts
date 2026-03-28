// Twemoji image URLs — reliable cross-platform emoji rendering.
// Keys are the unicode codepoints used over the wire via LiveKit data channel.
const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72';

export const REACTION_EMOJI = [
  { key: '1f44f', label: 'Clap' },
  { key: '1f4af', label: '100' },
  { key: '1f602', label: 'Joy' },
  { key: '1f62d', label: 'Sob' },
  { key: '1f44d', label: 'Thumbs up' },
] as const;

export type ReactionKey = (typeof REACTION_EMOJI)[number]['key'];

export function emojiImageUrl(key: string): string {
  return `${TWEMOJI_BASE}/${key}.png`;
}
