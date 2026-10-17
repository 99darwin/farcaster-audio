import Image from "next/image";

/**
 * Orange→purple hairline along the top edge — same color story as the
 * landing page's equalizer divider.
 */
export function BrandStripe() {
  return (
    <div
      className="h-1 bg-gradient-to-r from-juke-orange via-[#B45C7F] to-juke-purple"
      aria-hidden="true"
    />
  );
}

/** Logomark + JUKE wordmark with an optional context badge (e.g. "Developers"). */
export function BrandLockup({ badge }: { badge?: string }) {
  return (
    <span className="flex items-center gap-2">
      <Image
        src="/logomark.png"
        alt=""
        width={64}
        height={64}
        sizes="28px"
        className="h-7 w-7 brightness-0 invert"
      />
      <span className="font-display text-base font-bold tracking-[0.18em] text-juke-text-on-dark">
        JUKE
      </span>
      {badge && (
        <span className="ml-1 rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs font-medium text-juke-text-on-dark-secondary">
          {badge}
        </span>
      )}
    </span>
  );
}
