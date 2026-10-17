"use client";

import type { ReactionBubble } from "@/lib/space/spaceStore";

interface ReactionsLayerProps {
  reactions: ReactionBubble[];
}

/**
 * Floating emoji-reaction overlay. Each bubble drifts up and fades via the
 * `juke-float-up` keyframes; the capped store buffer bounds the DOM node count.
 */
export function ReactionsLayer({ reactions }: ReactionsLayerProps) {
  if (reactions.length === 0) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 bottom-24 z-30 mx-auto flex max-w-2xl justify-center"
    >
      <div className="relative h-0 w-full">
        {reactions.map((r) => (
          <span
            key={r.id}
            className="absolute bottom-0 text-3xl"
            style={{
              left: `${bubbleOffset(r.id)}%`,
              animation: "juke-float-up 2.4s ease-out forwards",
            }}
          >
            {r.key}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Deterministic horizontal jitter from the monotonic reaction id. */
function bubbleOffset(id: number): number {
  return 20 + ((id * 37) % 60);
}
