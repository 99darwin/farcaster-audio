import Link from "next/link";

/**
 * Gated placeholder slot for a future founding-drop / patronage CTA (spec §4,
 * §7). Off by default — renders nothing unless `NEXT_PUBLIC_SUPPORT_CTA_ENABLED`
 * is explicitly `"true"`. Intentionally does NOT create `/support` — this is
 * a link stub only, no payments surface.
 */
export function SupportCta() {
  if (process.env.NEXT_PUBLIC_SUPPORT_CTA_ENABLED !== "true") return null;

  return (
    <div className="rounded-2xl bg-gradient-to-br from-juke-orange/10 to-juke-purple/10 p-5 ring-1 ring-juke-border/60 sm:p-6">
      <p className="font-display text-lg font-bold text-juke-text-on-dark">
        Support Juke
      </p>
      <p className="mt-1.5 max-w-md text-sm text-juke-text-on-dark-secondary">
        Juke is built in the open, month by month. If you want to back what
        the people on this board are building, there&apos;s a way to help.
      </p>
      <Link
        href="/support"
        className="mt-4 inline-block rounded-full bg-juke-purple px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-juke-purple-hover"
      >
        Learn more
      </Link>
    </div>
  );
}
