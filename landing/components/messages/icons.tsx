/** Inline SVG icons for the messaging UI (no icon-library dependency). */

interface IconProps {
  className?: string;
}

const STROKE = {
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function ChatBubbleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path
        d="M20.25 11.5c0 4.28-3.69 7.75-8.25 7.75a8.9 8.9 0 0 1-3.2-.59L4.5 20.25l1.18-3.53A7.42 7.42 0 0 1 3.75 11.5C3.75 7.22 7.44 3.75 12 3.75s8.25 3.47 8.25 7.75Z"
        {...STROKE}
      />
    </svg>
  );
}

export function BackIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M15 5 8 12l7 7" {...STROKE} />
    </svg>
  );
}

export function ComposeIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" {...STROKE} />
      <path d="m13.5 6.5 4 4" {...STROKE} />
    </svg>
  );
}

export function SearchGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="11" cy="11" r="6.25" {...STROKE} />
      <path d="m20 20-3.5-3.5" {...STROKE} />
    </svg>
  );
}

export function ReplyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M10 8 5 12.5 10 17" {...STROKE} />
      <path d="M5.5 12.5H14a5 5 0 0 1 5 5V19" {...STROKE} />
    </svg>
  );
}

export function SmileIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" {...STROKE} />
      <path d="M8.75 14.25a4 4 0 0 0 6.5 0" {...STROKE} />
      <path d="M9.25 9.75h.01M14.75 9.75h.01" {...STROKE} strokeWidth={2.5} />
    </svg>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <rect x="8.25" y="8.25" width="11.5" height="11.5" rx="2" {...STROKE} />
      <path d="M15.75 8.25V6a1.75 1.75 0 0 0-1.75-1.75H6A1.75 1.75 0 0 0 4.25 6v8c0 .97.78 1.75 1.75 1.75h2.25" {...STROKE} />
    </svg>
  );
}

export function TrashIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M4.5 6.75h15M9.75 6.75V4.5h4.5v2.25M6.75 6.75l.75 12.75h9l.75-12.75" {...STROKE} />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" {...STROKE} />
    </svg>
  );
}

export function ChevronUpIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="m6 15 6-6 6 6" {...STROKE} />
    </svg>
  );
}

export function ChevronDownIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="m6 9 6 6 6-6" {...STROKE} />
    </svg>
  );
}

export function SendIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M4.5 12 3.75 4.5l16.5 7.5-16.5 7.5.75-7.5Zm0 0h7.5" {...STROKE} />
    </svg>
  );
}

export function ClockGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8" {...STROKE} />
      <path d="M12 8v4l2.5 1.5" {...STROKE} />
    </svg>
  );
}

export function AlertGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" {...STROKE} />
      <path d="M12 7.75v5M12 16.25h.01" {...STROKE} />
    </svg>
  );
}

export function PinGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M9 4.5h6l-1 5 3 3v1.5H7v-1.5l3-3-1-5ZM12 14v5.5" {...STROKE} />
    </svg>
  );
}

export function MutedGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M11 5 6.5 9H4v6h2.5L11 19V5ZM16 9.5l5 5M21 9.5l-5 5" {...STROKE} />
    </svg>
  );
}

export function PeopleGlyph({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="9" cy="8.5" r="3.25" {...STROKE} />
      <path d="M3.5 19c0-3 2.46-5.25 5.5-5.25S14.5 16 14.5 19" {...STROKE} />
      <path d="M15.5 5.5a3.25 3.25 0 0 1 0 6M17.5 13.9c1.76.68 3 2.4 3 4.6" {...STROKE} />
    </svg>
  );
}

export function EnvelopeOpenIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <path d="M3.75 9.5 12 4l8.25 5.5V19a1 1 0 0 1-1 1H4.75a1 1 0 0 1-1-1V9.5Z" {...STROKE} />
      <path d="m3.75 9.5 8.25 5.5 8.25-5.5" {...STROKE} />
    </svg>
  );
}
