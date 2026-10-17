/**
 * Minimal className joiner for the `/app` UI primitives.
 *
 * The project has no `clsx`/`tailwind-merge` dependency, so this keeps the
 * primitives free of an extra install while giving conditional-class support.
 * Falsy entries are dropped; the rest are space-joined.
 */
export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}
