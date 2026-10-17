"use client";

/**
 * CastText — renders a cast body with interactive entities. Mentions link to
 * the mentioned user's profile, channel references to the channel page, and
 * bare URLs open in a new tab. Everything else renders as plain text, preserving
 * whitespace/newlines (the caller supplies `whitespace-pre-wrap` in `className`).
 *
 * Web port of mobile `components/feed/CastText.tsx`. Entity links stop click
 * propagation so tapping one never also triggers the enclosing CastCard's
 * "open thread" handler.
 */

import { memo, useMemo } from "react";
import Link from "next/link";
import { tokenizeCast } from "@/lib/text/tokenize-cast";

interface CastTextProps {
  text: string;
  /** Applied to the wrapping <p>. Caller owns typography + whitespace handling. */
  className?: string;
}

const ENTITY_CLASS = "text-juke-purple hover:underline";

/** Swallow the click so entity taps don't bubble to the card's onPress. */
function stop(event: React.MouseEvent): void {
  event.stopPropagation();
}

function CastTextImpl({ text, className }: CastTextProps) {
  const segments = useMemo(() => tokenizeCast(text), [text]);

  return (
    <p className={className}>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case "mention":
            return (
              <Link
                key={i}
                href={`/app/profile/${seg.username}`}
                onClick={stop}
                className={ENTITY_CLASS}
              >
                {seg.value}
              </Link>
            );
          case "channel":
            return (
              <Link
                key={i}
                href={`/app/channel/${encodeURIComponent(seg.channelId)}`}
                onClick={stop}
                className={ENTITY_CLASS}
              >
                {seg.value}
              </Link>
            );
          case "url":
            return (
              <a
                key={i}
                href={seg.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={stop}
                className={ENTITY_CLASS}
              >
                {seg.value}
              </a>
            );
          default:
            return seg.value;
        }
      })}
    </p>
  );
}

export const CastText = memo(CastTextImpl);
