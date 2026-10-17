"use client";

/**
 * Host-console audio mixer — the "Sources" panel for publishers.
 *
 * A compact DJ/broadcast-style console rendered in a bottom {@link Sheet}.
 * Each mixer input (mic / external device / captured computer audio) gets a
 * channel strip: type glyph, live LED level meter (green→amber→red headroom),
 * volume fader, mute toggle, and remove. The mic strip is pinned first and
 * reads neutral (voice); computer audio carries the juke-orange "now playing"
 * energy; line-in/device strips take a cool sky accent so decks scan apart at
 * a glance.
 *
 * All live state comes from the audio engine contract
 * (`@/lib/space/audioMixer` / `audioDevices`): `subscribeSources` drives the
 * strip list, `subscribeLevels` drives the meters (no local AudioContext),
 * and every control maps 1:1 onto an engine call. One mixed track is
 * published — the LIVE header makes that explicit.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  addDeviceSource,
  addSystemAudioSource,
  ensureMixer,
  removeSource,
  setSourceGain,
  setSourceMuted,
  subscribeLevels,
  subscribeSources,
  SystemAudioUnsupportedError,
  type AudioSource,
  type LevelMap,
  type SourceKind,
} from "@/lib/space/audioMixer";
import {
  listAudioInputs,
  subscribeDeviceChange,
  type AudioInputDevice,
} from "@/lib/space/audioDevices";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/components/ui/cn";

// ── Tuning constants ─────────────────────────────────────────────────────────

/** LED segments per meter. */
const METER_SEGMENTS = 16;
/** Segment index boundaries for the green→amber→red headroom bands. */
const METER_AMBER_FROM = Math.floor(METER_SEGMENTS * 0.6);
const METER_RED_FROM = Math.floor(METER_SEGMENTS * 0.85);
/** A source is "hot" (header pulses) above this smoothed level. */
const HOT_LEVEL = 0.85;
/** Meter ballistics: instant attack, exponential release per level frame. */
const METER_RELEASE = 0.82;

/** Per-kind visual identity: glyph chip, strip border, fader accent, tag. */
const KIND_META: Record<
  SourceKind,
  {
    tag: string;
    chip: string;
    border: string;
    /** CSS accent-color for the native range fader. */
    accent: string;
  }
> = {
  mic: {
    tag: "Voice",
    chip: "bg-white/10 text-juke-text-on-dark",
    border: "border-juke-border",
    accent: "#a0a0c0",
  },
  system: {
    tag: "Computer audio",
    chip: "bg-juke-orange/20 text-juke-orange",
    border: "border-juke-orange/40",
    accent: "#D85A30",
  },
  device: {
    tag: "Line in",
    chip: "bg-sky-400/15 text-sky-300",
    border: "border-sky-400/40",
    accent: "#38bdf8",
  },
};

export interface AudioSourcesPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Sheet wrapper — the console content only mounts (and only subscribes to the
 * engine) while the sheet is open.
 */
export function AudioSourcesPanel({ open, onClose }: AudioSourcesPanelProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      className="max-h-[85vh] overflow-y-auto"
    >
      <MixerConsole />
    </Sheet>
  );
}

// ── Console ─────────────────────────────────────────────────────────────────

function MixerConsole() {
  const reduceMotion = useReducedMotion();

  const [sources, setSources] = useState<AudioSource[]>([]);
  const [levels, setLevels] = useState<LevelMap>({});
  const [devices, setDevices] = useState<AudioInputDevice[]>([]);
  const [busy, setBusy] = useState<"device" | "system" | null>(null);
  const [systemUnsupported, setSystemUnsupported] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Live strip list from the engine (fires immediately with a snapshot).
  useEffect(() => subscribeSources(setSources), []);

  // Meter levels, smoothed here (instant attack / slow release) so the LEDs
  // read musically instead of flickering with the raw analyser cadence.
  // Renders are gated on the quantized LED pattern: the subscription fires on
  // an animation cadence, but React only re-renders when a segment would
  // actually light or dim.
  useEffect(() => {
    const smoothed: LevelMap = {};
    let lastLedPattern = "";
    return subscribeLevels((next) => {
      for (const id of Object.keys(smoothed)) {
        if (!(id in next)) delete smoothed[id];
      }
      for (const [id, raw] of Object.entries(next)) {
        const prev = smoothed[id] ?? 0;
        smoothed[id] =
          raw >= prev ? raw : prev * METER_RELEASE + raw * (1 - METER_RELEASE);
      }
      const ledPattern = Object.entries(smoothed)
        .map(([id, v]) => `${id}:${Math.round(v * METER_SEGMENTS)}`)
        .join("|");
      if (ledPattern === lastLedPattern) return;
      lastLedPattern = ledPattern;
      setLevels({ ...smoothed });
    });
  }, []);

  // Device inventory for the "Add device" menu; refreshed on hot-plug.
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void listAudioInputs()
        .then((list) => {
          if (active) setDevices(list);
        })
        .catch(() => {
          // Enumeration failing just leaves the menu empty; not fatal.
        });
    };
    refresh();
    const unsubscribe = subscribeDeviceChange(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const handleAddDevice = useCallback(async (deviceId: string) => {
    setActionError(null);
    setBusy("device");
    try {
      ensureMixer();
      await addDeviceSource(deviceId);
    } catch {
      setActionError(
        "Couldn't add that device. Check it's connected and allowed.",
      );
    } finally {
      setBusy(null);
    }
  }, []);

  const handleShareSystemAudio = useCallback(async () => {
    setActionError(null);
    setSystemUnsupported(false);
    setBusy("system");
    try {
      ensureMixer();
      await addSystemAudioSource();
    } catch (err) {
      if (err instanceof SystemAudioUnsupportedError) {
        setSystemUnsupported(true);
      } else if (
        err instanceof DOMException &&
        (err.name === "NotAllowedError" || err.name === "AbortError")
      ) {
        // User dismissed the share picker — not an error state.
      } else {
        setActionError("Couldn't capture computer audio. Try again.");
      }
    } finally {
      setBusy(null);
    }
  }, []);

  // Mic strip pinned first; other decks keep engine (add) order.
  const orderedSources = [...sources].sort(
    (a, b) => Number(a.kind !== "mic") - Number(b.kind !== "mic"),
  );
  const isHot = orderedSources.some(
    (s) => !s.muted && (levels[s.id] ?? 0) > HOT_LEVEL,
  );
  const hasOnlyMic =
    sources.length <= 1 && sources.every((s) => s.kind === "mic");

  return (
    <div className="flex flex-col gap-4">
      {/* LIVE header — slots into the Sheet's title row (h-8 + mb-4 = mt-12),
          leaving room for its close button on the right. */}
      <header className="-mt-12 mb-1 pr-10">
        <div className="flex items-center gap-2">
          <motion.span
            aria-hidden
            className="inline-flex h-2 w-2 rounded-full bg-juke-orange"
            animate={
              isHot && !reduceMotion ? { scale: [1, 1.4, 1] } : { scale: 1 }
            }
            transition={
              isHot && !reduceMotion
                ? { duration: 0.8, repeat: Infinity, ease: "easeInOut" }
                : { duration: 0.2 }
            }
          />
          <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.15em] text-juke-orange">
            Live mix
          </h2>
        </div>
        <p className="mt-1 text-xs text-juke-text-on-dark-secondary">
          Mixing {sources.length} source{sources.length === 1 ? "" : "s"} into
          the one stream your listeners hear.
        </p>
      </header>

      {/* Channel strips */}
      <ul className="flex flex-col gap-2.5">
        <AnimatePresence initial={false} mode="popLayout">
          {orderedSources.map((source) => (
            <ChannelStrip
              key={source.id}
              source={source}
              level={levels[source.id] ?? 0}
              reduceMotion={!!reduceMotion}
            />
          ))}
        </AnimatePresence>
      </ul>

      {/* First-run teach card — casual hosts see why this panel exists. */}
      {hasOnlyMic && (
        <div className="rounded-xl border border-dashed border-juke-border bg-juke-navy/30 px-4 py-5 text-center">
          <p className="text-sm font-semibold text-juke-text-on-dark">
            It&apos;s just your mic right now
          </p>
          <p className="mx-auto mt-1 max-w-xs text-xs leading-relaxed text-juke-text-on-dark-secondary">
            Add computer audio to play intro music, or bring in a DJ rig or
            audio interface as another deck. Everything mixes live into your
            stream.
          </p>
        </div>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2">
        <AddDeviceMenu
          devices={devices}
          busy={busy === "device"}
          onSelect={(deviceId) => void handleAddDevice(deviceId)}
        />
        <button
          type="button"
          disabled={busy === "system"}
          onClick={() => void handleShareSystemAudio()}
          className="flex items-center gap-1.5 rounded-xl bg-juke-orange/15 px-3 py-2 text-sm font-semibold text-juke-orange transition-all hover:bg-juke-orange/25 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <MonitorSoundIcon />
          {busy === "system" ? "Choosing…" : "Share computer audio"}
        </button>
      </div>

      {systemUnsupported && (
        <p
          role="status"
          className="rounded-xl border border-juke-border bg-juke-navy/40 px-3 py-2 text-xs text-juke-text-on-dark-secondary"
        >
          Computer audio capture isn&apos;t supported in this browser — try
          Chrome or Edge. External devices still work above.
        </p>
      )}
      {actionError && (
        <p
          role="alert"
          className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
        >
          {actionError}
        </p>
      )}
    </div>
  );
}

// ── Channel strip ────────────────────────────────────────────────────────────

interface ChannelStripProps {
  source: AudioSource;
  /** Smoothed 0..1 output level for the meter. */
  level: number;
  reduceMotion: boolean;
}

function ChannelStrip({ source, level, reduceMotion }: ChannelStripProps) {
  const meta = KIND_META[source.kind];
  const [isDragging, setIsDragging] = useState(false);
  const gainPercent = Math.round(source.gain * 100);
  const isMic = source.kind === "mic";

  return (
    <motion.li
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={
        reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: -8 }
      }
      transition={{ type: "spring", stiffness: 420, damping: 32 }}
      className={cn(
        "rounded-xl border bg-juke-navy/40 p-3",
        meta.border,
        source.muted && "opacity-80",
      )}
    >
      {/* Row 1 — identity + strip actions */}
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            meta.chip,
          )}
        >
          <SourceGlyph kind={source.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-juke-text-on-dark">
            {source.label}
          </p>
          <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-juke-text-on-dark-tertiary">
            {meta.tag}
            {isMic && " · pinned"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setSourceMuted(source.id, !source.muted)}
          aria-pressed={source.muted}
          aria-label={
            source.muted ? `Unmute ${source.label}` : `Mute ${source.label}`
          }
          className={cn(
            "flex h-8 items-center rounded-lg px-2.5 text-xs font-semibold transition-all active:scale-95",
            source.muted
              ? "bg-juke-orange/20 text-juke-orange ring-1 ring-juke-orange/60"
              : "bg-white/5 text-juke-text-on-dark-secondary hover:bg-white/10",
          )}
        >
          {source.muted ? "Muted" : "Mute"}
        </button>
        {!isMic && (
          <button
            type="button"
            onClick={() => removeSource(source.id)}
            aria-label={`Remove ${source.label}`}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-juke-text-on-dark-tertiary transition-all hover:bg-red-500/15 hover:text-red-400 active:scale-95"
          >
            <RemoveIcon />
          </button>
        )}
      </div>

      {/* Row 2 — LED level meter */}
      <LevelMeter level={source.muted ? 0 : level} />

      {/* Row 3 — fader */}
      <div className="mt-1.5 flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={gainPercent}
          onChange={(e) =>
            setSourceGain(source.id, Number(e.currentTarget.value) / 100)
          }
          onPointerDown={() => setIsDragging(true)}
          onPointerUp={() => setIsDragging(false)}
          onPointerCancel={() => setIsDragging(false)}
          onBlur={() => setIsDragging(false)}
          aria-label={`${source.label} volume`}
          aria-valuetext={`${gainPercent}%`}
          style={{ accentColor: meta.accent }}
          className="h-1.5 min-w-0 flex-1 cursor-pointer"
        />
        <motion.span
          animate={
            reduceMotion ? undefined : { scale: isDragging ? 1.15 : 1 }
          }
          transition={{ type: "spring", stiffness: 500, damping: 25 }}
          className={cn(
            "w-9 shrink-0 text-right font-mono text-[11px] tabular-nums transition-colors",
            isDragging
              ? "font-semibold text-juke-text-on-dark"
              : "text-juke-text-on-dark-tertiary",
          )}
        >
          {gainPercent}%
        </motion.span>
      </div>
    </motion.li>
  );
}

// ── Level meter ──────────────────────────────────────────────────────────────

/**
 * Segmented LED ladder — thin rounded bars like the VoiceRecorder meter, laid
 * horizontally with green→amber→red headroom bands. Levels come pre-smoothed
 * from the console subscription; the 75ms opacity transition matches the
 * VoiceRecorder cadence so lighting reads continuous, not strobed.
 */
function LevelMeter({ level }: { level: number }) {
  const lit = Math.round(Math.min(Math.max(level, 0), 1) * METER_SEGMENTS);
  return (
    <div className="mt-2.5 flex h-2.5 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: METER_SEGMENTS }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-full min-w-0 flex-1 rounded-full transition-opacity duration-75",
            i < METER_AMBER_FROM
              ? "bg-emerald-400"
              : i < METER_RED_FROM
                ? "bg-amber-400"
                : "bg-red-500",
            i < lit ? "opacity-100" : "opacity-15",
          )}
        />
      ))}
    </div>
  );
}

// ── Add-device menu ──────────────────────────────────────────────────────────

interface AddDeviceMenuProps {
  devices: AudioInputDevice[];
  busy: boolean;
  onSelect: (deviceId: string) => void;
}

/**
 * "Add device" trigger with an upward popover listing audio inputs. Same
 * interaction contract as the Controls emoji popover: Escape / outside click /
 * re-toggle to dismiss, first item focused on open, ArrowUp/Down cycling, and
 * focus returned to the trigger on close.
 */
function AddDeviceMenu({ devices, busy, onSelect }: AddDeviceMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Focus first item when the menu opens; return focus to the trigger on
  // close. Guarded so the initial closed mount doesn't steal the Sheet's own
  // first-element focus.
  const hasOpenedRef = useRef(false);
  useEffect(() => {
    if (open) {
      hasOpenedRef.current = true;
      itemRefs.current[0]?.focus();
    } else if (hasOpenedRef.current) {
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onOutside = (e: MouseEvent | TouchEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("touchstart", onOutside);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("touchstart", onOutside);
    };
  }, [open]);

  const handleMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = itemRefs.current.filter(
      (b): b is HTMLButtonElement => b !== null,
    );
    if (items.length === 0) return;
    const current = items.findIndex((btn) => btn === document.activeElement);
    const delta = e.key === "ArrowDown" ? 1 : -1;
    items[(current + delta + items.length) % items.length]?.focus();
  }, []);

  return (
    <div ref={containerRef} className="relative">
      {open && (
        <div
          id="add-device-menu"
          role="menu"
          aria-label="Audio input devices"
          onKeyDown={handleMenuKeyDown}
          className="absolute bottom-full left-0 z-10 mb-2 max-h-56 w-64 overflow-y-auto rounded-xl border border-white/10 bg-juke-surface/98 p-1.5 shadow-2xl backdrop-blur-md"
        >
          {devices.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-juke-text-on-dark-tertiary">
              No input devices found. Plug one in and it&apos;ll appear here.
            </p>
          ) : (
            devices.map((device, i) => (
              <button
                key={device.deviceId || i}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onSelect(device.deviceId);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-juke-text-on-dark transition-colors hover:bg-white/10"
              >
                <span className="text-sky-300">
                  <PlugIcon />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {device.label || `Input device ${i + 1}`}
                </span>
              </button>
            ))
          )}
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        disabled={busy}
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls="add-device-menu"
        className="flex items-center gap-1.5 rounded-xl bg-sky-400/15 px-3 py-2 text-sm font-semibold text-sky-300 transition-all hover:bg-sky-400/25 active:scale-95 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <PlugIcon />
        {busy ? "Adding…" : "Add device"}
        <ChevronUpIcon
          className={cn(
            "h-2.5 w-2.5 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────────

function SourceGlyph({ kind }: { kind: SourceKind }) {
  if (kind === "system") return <MonitorSoundIcon />;
  if (kind === "device") return <PlugIcon />;
  return <MicGlyphIcon />;
}

function MicGlyphIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <rect
        x="9"
        y="3"
        width="6"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MonitorSoundIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <rect
        x="3"
        y="4"
        width="18"
        height="12"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path
        d="M12 16v4M8 20h8M9 12V8m3 4V9.5m3 2.5V8"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlugIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path
        d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-5 5 5 5 0 0 1-5-5V8ZM12 16v5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden>
      <path
        d="M6 6l12 12M18 6L6 18"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChevronUpIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 10 6" fill="none" className={className} aria-hidden>
      <path
        d="M1 5L5 1l4 4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
