"use client";

import { useState } from "react";
import { Avatar } from "@/components/ui/avatar";
import type { SessionParticipant } from "@/lib/space/spaceStore";

interface ListenerListProps {
  listeners: SessionParticipant[];
}

const PREVIEW_COUNT = 18;

/** Wrapped avatar grid of listeners with a show-all toggle. */
export function ListenerList({ listeners }: ListenerListProps) {
  const [showAll, setShowAll] = useState(false);

  if (listeners.length === 0) return null;

  const visible = showAll ? listeners : listeners.slice(0, PREVIEW_COUNT);

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        {visible.map((p) => (
          <div
            key={p.fid}
            className="flex w-14 flex-col items-center gap-1"
            title={p.display_name}
          >
            <Avatar src={p.pfp_url} name={p.display_name} size="md" />
            <span className="line-clamp-1 max-w-full text-center text-[10px] text-juke-text-on-dark-tertiary">
              {p.display_name}
            </span>
          </div>
        ))}
      </div>
      {listeners.length > PREVIEW_COUNT && (
        <button
          type="button"
          onClick={() => setShowAll((prev) => !prev)}
          className="mt-3 text-xs font-medium text-juke-text-on-dark-secondary transition-colors hover:text-juke-text-on-dark"
        >
          {showAll ? "Show less" : `Show all ${listeners.length}`}
        </button>
      )}
    </div>
  );
}
