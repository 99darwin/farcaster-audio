import { safeImageUrl } from "@/lib/safe-url";
import { cn } from "./cn";

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

export interface AvatarProps {
  /** User-controlled pfp URL; validated to https before use. */
  src: string | null | undefined;
  /** Display name — drives the alt text and the initials fallback. */
  name: string;
  size?: AvatarSize;
  className?: string;
}

const SIZE_CLASSES: Record<AvatarSize, string> = {
  xs: "h-6 w-6 text-[10px]",
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-14 w-14 text-base",
  xl: "h-20 w-20 text-xl",
};

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() : "?";
}

/**
 * Circular avatar. Renders the pfp when it is a safe https URL, otherwise a
 * navy-surface fallback with the first initial. Consolidates the pattern
 * duplicated across the feed-item components.
 */
export function Avatar({ src, name, size = "md", className }: AvatarProps) {
  const safe = safeImageUrl(src);
  const base = cn(
    "shrink-0 overflow-hidden rounded-full",
    SIZE_CLASSES[size],
    className,
  );

  if (safe) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote pfp hosts vary; next/image remote allow-list is out of scope here
      <img
        src={safe}
        alt={name}
        referrerPolicy="no-referrer"
        className={cn(base, "object-cover")}
      />
    );
  }

  return (
    <div
      aria-label={name}
      className={cn(
        base,
        "flex items-center justify-center bg-juke-surface font-bold text-juke-text-on-dark",
      )}
    >
      {initial(name)}
    </div>
  );
}
