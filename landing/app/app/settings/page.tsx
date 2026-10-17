"use client";

/**
 * Settings — account, appearance, and notification preferences on one page.
 *
 * Combines the mobile `settings.tsx`, `appearance-settings.tsx`, and
 * `notification-settings.tsx` screens into stacked sections:
 *   - Account: current user + sign out (`useAuth`).
 *   - Appearance: theme + Winamp mode (persisted via `prefsStore`).
 *   - Notifications: server-side push preferences (`/v1/push/preferences`).
 *
 * Browser push delivery is out of scope on web; the notification toggles persist
 * the user's server preferences (honored by mobile / any future web push).
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useAuth } from "@/lib/auth/AuthProvider";
import {
  usePrefsStore,
  usePrefsHydrated,
  type ThemePreference,
} from "@/lib/stores/prefsStore";
import {
  getPushPreferences,
  updatePushPreferences,
  type PushPreferences,
} from "@/lib/api/settings";
import { getLeaderboardMe, setLeaderboardOptOut } from "@/lib/api/leaderboard";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { Toggle } from "@/components/ui/toggle";
import { cn } from "@/components/ui/cn";

// ---------------------------------------------------------------------------
// Small local primitives.
// ---------------------------------------------------------------------------

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-6">
      <h2 className="px-4 pb-2 text-xs font-semibold uppercase tracking-wide text-juke-text-on-dark-secondary">
        {title}
      </h2>
      <div className="divide-y divide-juke-border border-y border-juke-border bg-juke-surface">
        {children}
      </div>
    </section>
  );
}

/**
 * Row used inside a Section that already provides `divide-y` separators.
 * Uses the shared Toggle for the switch visual.
 */
function ToggleRow({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  // Derive a stable DOM id from the label for <label htmlFor> association.
  const toggleId = `settings-toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  return (
    <div className="flex items-center gap-3 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <label
          htmlFor={toggleId}
          className={cn(
            "text-sm font-medium cursor-pointer",
            disabled
              ? "text-juke-text-on-dark-tertiary"
              : "text-juke-text-on-dark",
          )}
        >
          {label}
        </label>
        {hint && (
          <p className="mt-0.5 text-xs text-juke-text-on-dark-secondary">
            {hint}
          </p>
        )}
      </div>
      <Toggle
        id={toggleId}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        label={label}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  description: string;
}> = [
  {
    value: "system",
    label: "System",
    description: "Follow your device's appearance",
  },
  { value: "dark", label: "Dark", description: "Deep navy background" },
];

function AppearanceSection() {
  const hydrated = usePrefsHydrated();
  const theme = usePrefsStore((s) => s.theme);
  const setTheme = usePrefsStore((s) => s.setTheme);
  const winampMode = usePrefsStore((s) => s.winampMode);
  const setWinampMode = usePrefsStore((s) => s.setWinampMode);

  return (
    <Section title="Appearance">
      <div className="px-4 py-3.5">
        <p className="mb-2 text-sm font-medium text-juke-text-on-dark">Theme</p>
        <div
          role="radiogroup"
          aria-label="Theme"
          className="flex flex-col gap-2"
        >
          {THEME_OPTIONS.map((option) => {
            const selected = hydrated && theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setTheme(option.value)}
                className={cn(
                  "flex items-center justify-between rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-juke-orange",
                  selected
                    ? "border-juke-orange bg-juke-navy/40"
                    : "border-juke-border hover:bg-juke-navy/30",
                )}
              >
                <span>
                  <span className="block text-sm font-medium text-juke-text-on-dark">
                    {option.label}
                  </span>
                  <span className="block text-xs text-juke-text-on-dark-secondary">
                    {option.description}
                  </span>
                </span>
                {selected && (
                  <span
                    aria-hidden
                    className="text-sm font-bold text-juke-orange"
                  >
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <ToggleRow
        label="Winamp Mode"
        hint="Retro player skin for audio spaces"
        checked={hydrated ? winampMode : false}
        onChange={setWinampMode}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/**
 * Opt-out of the public recognition leaderboard. Reads the current flag from
 * `GET /v1/leaderboard/me` (so the toggle reflects reality even if it was
 * changed elsewhere) and writes via `PUT /v1/leaderboard/opt-out`, optimistic
 * with revert-on-failure like the notification toggles above.
 */
function LeaderboardSection() {
  const [optOut, setOptOut] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    getLeaderboardMe()
      .then((me) => {
        if (active && me) setOptOut(me.opt_out);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleToggle = useCallback(async (value: boolean) => {
    setOptOut(value); // optimistic
    try {
      const result = await setLeaderboardOptOut(value);
      setOptOut(result.opt_out);
    } catch {
      setOptOut(!value);
    }
  }, []);

  return (
    <Section title="Leaderboard">
      <ToggleRow
        label="Hide me from the leaderboard"
        hint="Keeps you out of the public Top Hosts, Top Voices, Top Casters, and Community boards."
        checked={optOut}
        disabled={loading}
        onChange={(value) => void handleToggle(value)}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

interface NotifToggle {
  key: keyof PushPreferences;
  label: string;
  disabled?: boolean;
  hint?: string;
}

const FARCASTER_TOGGLES: NotifToggle[] = [
  { key: "follows_enabled", label: "Follows" },
  { key: "likes_enabled", label: "Likes" },
  { key: "replies_enabled", label: "Comments" },
  { key: "recasts_enabled", label: "Recasts" },
];

const SPACE_TOGGLES: NotifToggle[] = [
  { key: "space_started_enabled", label: "Space Started" },
  { key: "space_invited_enabled", label: "Invited to Speak" },
  { key: "hand_raised_enabled", label: "Hand Raised" },
];

const OTHER_TOGGLES: NotifToggle[] = [
  {
    key: "miniapp_enabled",
    label: "Mini App Notifications",
    disabled: true,
    hint: "Coming soon",
  },
];

function NotificationSection() {
  const [prefs, setPrefs] = useState<PushPreferences | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPrefs(await getPushPreferences());
    } catch {
      setError("Couldn't load notification preferences.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = useCallback(
    async (key: keyof PushPreferences, value: boolean) => {
      // Optimistic update; revert on failure.
      setPrefs((prev) => (prev ? { ...prev, [key]: value } : prev));
      try {
        const updated = await updatePushPreferences({ [key]: value });
        setPrefs(updated);
      } catch {
        setPrefs((prev) => (prev ? { ...prev, [key]: !value } : prev));
      }
    },
    [],
  );

  const renderGroup = (title: string, toggles: NotifToggle[]) => (
    <Section title={title}>
      {toggles.map((toggle) => (
        <ToggleRow
          key={toggle.key}
          label={toggle.label}
          hint={toggle.hint}
          disabled={toggle.disabled || !prefs}
          checked={prefs ? prefs[toggle.key] : false}
          onChange={(value) => void handleToggle(toggle.key, value)}
        />
      ))}
    </Section>
  );

  if (loading) {
    return (
      <Section title="Notifications">
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      </Section>
    );
  }

  if (error || !prefs) {
    return (
      <Section title="Notifications">
        <div className="px-4 py-6">
          <p className="text-sm text-juke-text-on-dark-secondary">
            {error ?? "Couldn't load notification preferences."}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            onClick={() => void load()}
          >
            Try again
          </Button>
        </div>
      </Section>
    );
  }

  return (
    <>
      {renderGroup("Notifications · Farcaster", FARCASTER_TOGGLES)}
      {renderGroup("Notifications · Spaces", SPACE_TOGGLES)}
      {renderGroup("Notifications · Other", OTHER_TOGGLES)}
      <p className="px-4 pt-3 text-xs text-juke-text-on-dark-secondary">
        These control which events notify you. Browser push isn't available on
        web yet — your preferences still apply on mobile.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function AccountSection() {
  const { user, signOut } = useAuth();
  const [signingOut, setSigningOut] = useState(false);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }, [signOut]);

  return (
    <Section title="Account">
      {user && (
        <div className="flex items-center gap-3 px-4 py-4">
          <Avatar src={user.pfp_url} name={user.display_name} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-juke-text-on-dark">
              {user.display_name}
            </p>
            <p className="truncate text-sm text-juke-text-on-dark-secondary">
              @{user.username}
            </p>
          </div>
        </div>
      )}
      <div className="px-4 py-3.5">
        <Button
          variant="danger"
          loading={signingOut}
          onClick={() => void handleSignOut()}
        >
          Sign out
        </Button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  const { status, signIn } = useAuth();

  if (status === "loading") {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  if (status === "anonymous") {
    return (
      <EmptyState
        title="Sign in to manage settings"
        description="Connect Farcaster to update your appearance and notification preferences."
        action={<Button onClick={() => void signIn()}>Connect Farcaster</Button>}
      />
    );
  }

  return (
    <div className="flex flex-col pb-8">
      <header className="border-b border-juke-border px-4 py-4">
        <h1 className="text-lg font-semibold text-juke-text-on-dark">
          Settings
        </h1>
      </header>

      <AccountSection />
      <AppearanceSection />
      <LeaderboardSection />
      <NotificationSection />
    </div>
  );
}
