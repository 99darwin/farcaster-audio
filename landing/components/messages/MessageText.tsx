"use client";

import { Fragment, memo, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { tokenizeCast } from "@/lib/text/tokenize-cast";
import { highlightSegments, type HighlightSegment } from "@/lib/messages/highlight";
import { mentionHref } from "@/lib/messages/format";
import { cn } from "@/components/ui/cn";

export interface MessageTextProps {
  text: string;
  /** Search terms to mark (case-insensitive). */
  highlightTerms?: readonly string[];
  className?: string;
  /** Link color class; own bubbles sit on orange, so they need a lighter one. */
  linkClassName?: string;
}

/** `<mark>` every occurrence of `terms` in a plain text run. */
export function HighlightedText({
  text,
  terms,
}: {
  text: string;
  terms?: readonly string[];
}): ReactNode {
  if (!terms || terms.length === 0) return text;
  return <SegmentedText segments={highlightSegments(text, terms)} />;
}

/** Renders precomputed highlight segments with matches in `<mark>`. */
export function SegmentedText({ segments }: { segments: readonly HighlightSegment[] }): ReactNode {
  return segments.map((segment, index) =>
    segment.match ? (
      <mark
        key={index}
        className="rounded-[3px] bg-juke-orange/35 px-0.5 text-inherit"
      >
        {segment.text}
      </mark>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}

/**
 * Message body: mentions link to profiles, channels to channel pages, URLs
 * open in a new tab; everything else is plain text (never HTML), with search
 * terms marked.
 */
function MessageTextImpl({
  text,
  highlightTerms,
  className,
  linkClassName = "text-juke-purple underline-offset-2 hover:underline",
}: MessageTextProps) {
  const segments = useMemo(() => tokenizeCast(text), [text]);
  return (
    <p className={cn("whitespace-pre-wrap break-words [overflow-wrap:anywhere]", className)}>
      {segments.map((segment, index) => {
        switch (segment.type) {
          case "mention":
            return (
              <Link key={index} href={mentionHref(segment.username)} className={linkClassName}>
                <HighlightedText text={segment.value} terms={highlightTerms} />
              </Link>
            );
          case "channel":
            return (
              <Link
                key={index}
                href={`/app/channel/${encodeURIComponent(segment.channelId)}`}
                className={linkClassName}
              >
                <HighlightedText text={segment.value} terms={highlightTerms} />
              </Link>
            );
          case "url":
            return (
              <a
                key={index}
                href={segment.href}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClassName}
              >
                <HighlightedText text={segment.value} terms={highlightTerms} />
              </a>
            );
          default:
            return (
              <HighlightedText key={index} text={segment.value} terms={highlightTerms} />
            );
        }
      })}
    </p>
  );
}

export const MessageText = memo(MessageTextImpl);
