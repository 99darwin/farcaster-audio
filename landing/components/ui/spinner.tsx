import { cn } from "./cn";

export interface SpinnerProps {
  /** Diameter token. */
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Accessible label announced to screen readers. */
  label?: string;
}

const SIZE_CLASSES: Record<NonNullable<SpinnerProps["size"]>, string> = {
  sm: "h-4 w-4 border-2",
  md: "h-6 w-6 border-2",
  lg: "h-8 w-8 border-[3px]",
};

/**
 * Brand loading spinner — a warm-orange ring with a transparent top edge.
 * Purely decorative visually, but exposes an aria-label for assistive tech.
 */
export function Spinner({ size = "md", className, label = "Loading" }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-block animate-spin rounded-full border-juke-border border-t-juke-orange",
        SIZE_CLASSES[size],
        className,
      )}
    />
  );
}
