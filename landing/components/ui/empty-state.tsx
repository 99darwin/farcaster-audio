import type { ReactNode } from "react";
import { cn } from "./cn";

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Optional leading glyph/illustration. */
  icon?: ReactNode;
  /** Optional call-to-action (e.g. a Button/LinkButton). */
  action?: ReactNode;
  className?: string;
}

/**
 * Centered placeholder for empty feeds, search results, notifications, etc.
 * Keeps the warm, quiet brand tone rather than a stark blank slate.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center px-6 py-16 text-center",
        className,
      )}
    >
      {icon && (
        <div className="mb-4 text-juke-text-on-dark-tertiary">{icon}</div>
      )}
      <p className="text-base font-semibold text-juke-text-on-dark">{title}</p>
      {description && (
        <p className="mt-1 max-w-xs text-sm text-juke-text-on-dark-secondary">
          {description}
        </p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
