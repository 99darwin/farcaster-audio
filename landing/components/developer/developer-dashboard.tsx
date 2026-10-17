"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { BrandLockup, BrandStripe } from "@/components/developer/brand";
import QRCode from "qrcode";
import { FarcasterSignIn } from "@/components/auth/FarcasterSignIn";
import type { LoginResponse } from "@/lib/api/types";
import {
  DeveloperApiError,
  ReauthRequiredError,
  createDeveloperApiClient,
  maskDeveloperKey,
  type CreateDeveloperKeyResponse,
  type DeveloperApiClient,
  type DeveloperApp,
  type DeveloperBot,
  type DeveloperDashboardResponse,
  type DeveloperStatus,
} from "@/lib/developer-api";
import { safeImageUrl } from "@/lib/safe-url";

type PreviewStatus = DeveloperStatus | null;

type DeveloperDashboardProps = {
  initialPreviewStatus: PreviewStatus;
};

type LoadState = "idle" | "loading" | "ready" | "error";

const SNIPPETS = {
  iframe: `<iframe
  src="https://juke.audio/embed/{spaceId}"
  allow="autoplay; microphone"
  style="width:100%;max-width:420px;height:620px;border:0;border-radius:24px"
></iframe>`,
  server: `await fetch("https://your-api-host.example.com/v1/developer/spaces", {
  method: "POST",
  headers: {
    "X-Juke-Api-Key": process.env.JUKE_API_KEY,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    title: "Weekly builder room",
    scheduled_at: null,
    announce_cast: false,
    allow_agents: true,
  }),
});`,
};

const PREVIEW_CONTROLS_ENABLED = process.env.NODE_ENV !== "production";

const previewDashboard: Record<DeveloperStatus, DeveloperDashboardResponse> = {
  none: {
    profile: {
      fid: 12345,
      username: "builder",
      displayName: "Juke Builder",
      status: "none",
    },
    apps: [],
  },
  pending: {
    profile: {
      fid: 12345,
      username: "builder",
      displayName: "Juke Builder",
      status: "pending",
    },
    apps: [],
  },
  approved: {
    profile: {
      fid: 12345,
      username: "builder",
      displayName: "Juke Builder",
      status: "approved",
      reviewedAt: "2026-05-11T12:00:00.000Z",
    },
    apps: [
      {
        id: "app_preview_1",
        name: "Listening Bar",
        description: "Custom audio rooms inside our community site.",
        websiteUrl: "https://example.com",
        allowedOrigins: ["https://example.com"],
        createdAt: "2026-05-11T12:00:00.000Z",
        updatedAt: null,
        keys: [
          {
            appId: "app_preview_1",
            keyId: "preview001",
            name: "Production server",
            status: "active",
            createdAt: "2026-05-11T12:15:00.000Z",
            lastUsedAt: null,
            revokedAt: null,
          },
        ],
      },
    ],
  },
  suspended: {
    profile: {
      fid: 12345,
      username: "builder",
      displayName: "Juke Builder",
      status: "suspended",
      suspensionReason: "API access is paused while we review your app.",
    },
    apps: [],
  },
};

export function DeveloperDashboard({
  initialPreviewStatus,
}: DeveloperDashboardProps) {
  const clientRef = useRef<DeveloperApiClient | null>(null);
  // Step-up re-auth: a dangerous mutation (rotate/revoke/reveal/delete)
  // needs a fresh sign-in. The session stays valid — we just surface the
  // sign-in panel again, distinct from a "session expired" sign-out.
  const [reauthNeeded, setReauthNeeded] = useState(false);
  const [previewStatus, setPreviewStatus] =
    useState<PreviewStatus>(initialPreviewStatus);
  const [dashboard, setDashboard] = useState<DeveloperDashboardResponse | null>(
    initialPreviewStatus ? previewDashboard[initialPreviewStatus] : null,
  );
  const [loadState, setLoadState] = useState<LoadState>(
    initialPreviewStatus ? "ready" : "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [secretReveal, setSecretReveal] =
    useState<CreateDeveloperKeyResponse | null>(null);
  // While `hydrating`, the cold-start refresh-cookie probe is still in
  // flight. We deliberately render neither the sign-in prompt nor the
  // authenticated UI during this window — flashing "Sign in" before the
  // restored session lands is what made every refresh feel broken.
  // Preview mode bypasses hydration because it renders mock data.
  const [hydrating, setHydrating] = useState(!initialPreviewStatus);

  if (!clientRef.current) clientRef.current = createDeveloperApiClient();

  const profile = dashboard?.profile ?? null;
  const isSignedIn = Boolean(dashboard);

  // Cold-start session rehydration. The JWT lives only in memory and
  // dies on a hard reload, but the HttpOnly `juke_refresh` cookie
  // persists — so on mount we ask the backend to mint a fresh JWT from
  // it. `restoreSession()` returns null on 401 (no valid cookie) so
  // first-time visitors fall straight through to the sign-in UI.
  useEffect(() => {
    if (initialPreviewStatus) {
      setHydrating(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const restored = await clientRef.current!.restoreSession();
        if (cancelled) return;
        if (restored) {
          await loadDashboard();
        }
      } catch {
        // Swallow — falling through to the signed-out UI is the right
        // behavior here. Surface real errors via loadDashboard's own
        // error handling once we have a session.
      } finally {
        if (!cancelled) setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reload when the preview toggle flips off (dev tools only). The
  // initial-mount hydration above handles the cold-start case; this
  // effect handles the live transition from preview → real data
  // without double-loading on first render.
  useEffect(() => {
    if (previewStatus) return;
    if (hydrating) return;
    const client = clientRef.current;
    if (!client?.currentSession) return;
    void loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewStatus]);

  // `FarcasterSignIn` mints the session (Protocol Auth, cookie mode); adopt
  // it into the developer client, then (re)load the dashboard.
  async function handleLogin(response: LoginResponse) {
    setPendingAction("Completing sign in");
    setError(null);
    setPreviewStatus(null);
    try {
      clientRef.current!.completeLogin(response);
      setReauthNeeded(false);
      await loadDashboard();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPendingAction(null);
    }
  }


  async function loadDashboard() {
    setLoadState("loading");
    setError(null);
    try {
      const next = await clientRef.current!.getDashboard();
      setDashboard(next);
      setPreviewStatus(null);
      setLoadState("ready");
    } catch (err) {
      if (err instanceof DeveloperApiError && err.status === 401) {
        setDashboard(null);
        setLoadState("idle");
      } else {
        setError(errorMessage(err));
        setLoadState("error");
      }
    }
  }

  function signOut() {
    clientRef.current!.signOut();
    setReauthNeeded(false);
    setDashboard(null);
    setPreviewStatus(null);
    setLoadState("idle");
    setSecretReveal(null);
    setError(null);
  }

  function showPreview(status: PreviewStatus) {
    setSecretReveal(null);
    setError(null);
    setPreviewStatus(status);
    setLoadState(status ? "ready" : "idle");
    setDashboard(status ? previewDashboard[status] : null);
  }

  async function submitApplication(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Capture the form element before any `await` — React nulls
    // `event.currentTarget` once the handler yields, which makes
    // `event.currentTarget.reset()` throw on the success path.
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setPendingAction("Submitting application");
    setError(null);
    try {
      if (previewStatus) {
        setDashboard(previewDashboard.pending);
        setPreviewStatus("pending");
      } else {
        const next = await clientRef.current!.submitApplication({
          projectName: String(form.get("projectName") || ""),
          websiteUrl: String(form.get("websiteUrl") || ""),
          useCase: String(form.get("useCase") || ""),
        });
        setDashboard(next);
      }
      formEl.reset();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPendingAction(null);
    }
  }

  async function createApp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const allowedOrigins = String(form.get("allowedOrigins") || "")
      .split(/\s*,\s*/)
      .map((origin) => origin.trim())
      .filter(Boolean);

    setPendingAction("Creating app");
    setError(null);
    try {
      let app: DeveloperApp;
      if (previewStatus) {
        app = {
          id: `app_preview_${Date.now()}`,
          name: String(form.get("name") || "Untitled app"),
          description: String(form.get("description") || ""),
          websiteUrl: String(form.get("websiteUrl") || ""),
          allowedOrigins,
          createdAt: new Date().toISOString(),
          updatedAt: null,
          keys: [],
        };
      } else {
        app = await clientRef.current!.createApp({
          name: String(form.get("name") || ""),
          description: String(form.get("description") || ""),
          websiteUrl: String(form.get("websiteUrl") || ""),
          allowedOrigins,
        });
      }
      setDashboard((current) =>
        current ? { ...current, apps: [app, ...current.apps] } : current,
      );
      formEl.reset();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPendingAction(null);
    }
  }

  async function createKey(appId: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const name = String(form.get("keyName") || "");
    await runKeyMutation("Creating key", async () => {
      const response = previewStatus
        ? previewKeyResponse(name)
        : await clientRef.current!.createKey(appId, { name });
      addOrReplaceKey(appId, response.key);
      setSecretReveal(response);
      formEl.reset();
    });
  }

  async function rotateKey(appId: string, keyId: string) {
    const key = findKey(keyId);
    if (!confirmKeyAction("rotate", key?.name ?? keyId)) return;
    await runKeyMutation("Rotating key", async () => {
      const response = previewStatus
        ? previewKeyResponse("Rotated server key")
        : await clientRef.current!.rotateKey(appId, keyId);
      rotateKeyInState(appId, keyId, response.key);
      setSecretReveal(response);
    });
  }

  async function revokeKey(appId: string, keyId: string) {
    const key = findKey(keyId);
    if (!confirmKeyAction("revoke", key?.name ?? keyId)) return;
    await runKeyMutation("Revoking key", async () => {
      const revoked = previewStatus
        ? {
            ...(key ?? {
              appId,
              keyId,
              name: "Server key",
              createdAt: new Date().toISOString(),
            }),
            status: "revoked" as const,
            revokedAt: new Date().toISOString(),
          }
        : await clientRef.current!.revokeKey(appId, keyId);
      replaceKeyById(keyId, {
        ...(key ?? revoked),
        ...revoked,
        keyId,
        status: "revoked",
        revokedAt: revoked.revokedAt ?? new Date().toISOString(),
      });
      if (secretReveal?.key.keyId === keyId) setSecretReveal(null);
    });
  }

  async function revealKeyOnce(response: CreateDeveloperKeyResponse) {
    const revealToken = response.revealToken;
    if (!revealToken) return;
    await runKeyMutation("Revealing key", async () => {
      if (previewStatus) {
        setSecretReveal({ ...response, secret: response.secret || previewSecret(response.key.keyId) });
        return;
      }
      const revealed = await clientRef.current!.revealKey(
        response.key.appId,
        response.key.keyId,
        revealToken,
      );
      setSecretReveal({
        ...response,
        secret: revealed.secret,
        revealToken: null,
      });
    });
  }

  async function runKeyMutation(label: string, callback: () => Promise<void>) {
    setPendingAction(label);
    setError(null);
    try {
      await callback();
    } catch (err) {
      if (err instanceof ReauthRequiredError) {
        // Step-up required: keep the session, surface the sign-in panel
        // again. The user re-signs, then retries the action — we
        // deliberately do NOT auto-retry, the original action stays explicit.
        setReauthNeeded(true);
        setError(err.message || "Sign in again to continue.");
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setPendingAction(null);
    }
  }

  function addOrReplaceKey(appId: string, key: DeveloperApp["keys"][number]) {
    setDashboard((current) => {
      if (!current) return current;
      return {
        ...current,
        apps: current.apps.map((app) =>
          app.id === appId
            ? {
                ...app,
                keys: [
                  key,
                  ...app.keys.filter((item) => item.keyId !== key.keyId),
                ],
              }
            : app,
        ),
      };
    });
  }

  function replaceKeyById(keyId: string, key: DeveloperApp["keys"][number]) {
    setDashboard((current) => {
      if (!current) return current;
      return {
        ...current,
        apps: current.apps.map((app) => ({
          ...app,
          keys: app.keys.map((item) => (item.keyId === keyId ? key : item)),
        })),
      };
    });
  }

  function rotateKeyInState(
    appId: string,
    oldKeyId: string,
    nextKey: DeveloperApp["keys"][number],
  ) {
    const revokedAt = new Date().toISOString();
    setDashboard((current) => {
      if (!current) return current;
      return {
        ...current,
        apps: current.apps.map((app) => {
          if (app.id !== appId) return app;
          const keys = app.keys.map((item) =>
            item.keyId === oldKeyId
              ? { ...item, status: "revoked" as const, revokedAt }
              : item,
          );
          return {
            ...app,
            keys: [nextKey, ...keys.filter((item) => item.keyId !== nextKey.keyId)],
          };
        }),
      };
    });
  }

  function findKey(keyId: string): DeveloperApp["keys"][number] | null {
    for (const app of dashboard?.apps ?? []) {
      const key = app.keys.find((item) => item.keyId === keyId);
      if (key) return key;
    }
    return null;
  }

  const statusChip = useMemo(() => {
    if (!profile) return null;
    if (profile.status === "approved") {
      return <Chip tone="success">Approved</Chip>;
    }
    if (profile.status === "pending") {
      return <Chip tone="muted">In review</Chip>;
    }
    if (profile.status === "none") {
      return <Chip tone="muted">Not requested</Chip>;
    }
    return <Chip tone="warning">Suspended</Chip>;
  }, [profile]);

  return (
    <main className="min-h-screen bg-juke-navy text-juke-text-on-dark">
      <BrandStripe />
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
        <TopBar
          isSignedIn={isSignedIn}
          statusChip={statusChip}
          onSignOut={signOut}
        />

        <div className="mt-8 sm:mt-12 max-w-3xl">
          <p className="text-sm font-semibold uppercase tracking-wide text-juke-orange">
            For developers
          </p>
          <h1 className="font-display mt-2 text-3xl font-bold leading-tight sm:text-4xl">
            Juke developer keys
          </h1>
          <p className="mt-3 text-base text-juke-text-on-dark-secondary">
            Embed Juke spaces in your product. Hosted iframes are keyless;
            developer keys unlock server APIs for custom integrations.
          </p>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-4">
            {(error || pendingAction) && (
              <Banner tone={error ? "error" : "info"}>
                {error ?? `${pendingAction}…`}
              </Banner>
            )}

            {hydrating && <HydratingPanel />}

            {!hydrating && !dashboard && (
              <SignedOutPanel loadState={loadState} onLogin={handleLogin} />
            )}

            {dashboard && reauthNeeded && <ReauthPanel onLogin={handleLogin} />}

            {profile?.status === "none" && (
              <NoApplicationPanel
                profileName={profile.displayName || profile.username}
                onSubmitApplication={submitApplication}
              />
            )}

            {profile?.status === "pending" && (
              <PendingPanel profileName={profile.displayName || profile.username} />
            )}

            {profile?.status === "suspended" && (
              <SuspendedPanel reason={profile.suspensionReason} />
            )}

            {profile?.status === "approved" && (
              <ApprovedPanel
                apps={dashboard?.apps ?? []}
                onCreateApp={createApp}
                onCreateKey={createKey}
                onRotateKey={rotateKey}
                onRevokeKey={revokeKey}
              />
            )}
          </div>

          <aside className="min-w-0 space-y-4">
            {secretReveal && (
              <SecretReveal
                response={secretReveal}
                onReveal={() => revealKeyOnce(secretReveal)}
                onDismiss={() => setSecretReveal(null)}
              />
            )}
            <IntegrationGuide />
          </aside>
        </div>
      </div>

      {PREVIEW_CONTROLS_ENABLED && (
        <PreviewControls
          isSignedIn={isSignedIn}
          previewStatus={previewStatus}
          onChange={showPreview}
        />
      )}
    </main>
  );
}

function TopBar({
  isSignedIn,
  statusChip,
  onSignOut,
}: {
  isSignedIn: boolean;
  statusChip: ReactNode;
  onSignOut: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <a
        href="/"
        className="transition-opacity hover:opacity-80"
        aria-label="Juke home"
      >
        <BrandLockup badge="Developers" />
      </a>
      <div className="flex items-center gap-3">
        {statusChip}
        {isSignedIn && (
          <button
            type="button"
            onClick={onSignOut}
            className="rounded-full border border-white/10 px-3 py-1.5 text-sm text-juke-text-on-dark-secondary transition hover:border-white/25 hover:text-white"
          >
            Sign out
          </button>
        )}
      </div>
    </div>
  );
}

// Neutral placeholder shown while the cold-start refresh-cookie probe
// is in flight. Avoids the "Sign in" flash on hard reload for users
// who already have a valid session cookie.
function HydratingPanel() {
  return (
    <Card>
      <p className="text-sm text-juke-text-on-dark-secondary">Loading…</p>
    </Card>
  );
}

function SignedOutPanel({
  loadState,
  onLogin,
}: {
  loadState: LoadState;
  onLogin: (response: LoginResponse) => Promise<void>;
}) {
  return (
    <Card>
      <h2 className="font-display text-xl font-semibold text-white">
        Sign in with Farcaster
      </h2>
      <div className="mt-5">
        <FarcasterSignIn onLogin={onLogin} />
      </div>
      {loadState === "error" && (
        <p className="mt-3 text-xs text-juke-text-on-dark-tertiary">
          Sign in is required before requesting developer access.
        </p>
      )}
    </Card>
  );
}

// Step-up re-auth prompt. Distinct from "session expired" — the session
// is still valid; a dangerous mutation just needs a fresh sign-in. The
// sign-in panel mints a fresh session; the user then retries.
function ReauthPanel({
  onLogin,
}: {
  onLogin: (response: LoginResponse) => Promise<void>;
}) {
  return (
    <Card className="border-juke-orange/40 bg-juke-orange/10">
      <h2 className="font-display text-xl font-semibold text-white">Confirm it&apos;s you</h2>
      <p className="mt-2 text-sm text-orange-50/80">
        For your security, sign in again to continue with that action.
      </p>
      <div className="mt-5">
        <FarcasterSignIn onLogin={onLogin} label="Sign in again" />
      </div>
    </Card>
  );
}

function NoApplicationPanel({
  profileName,
  onSubmitApplication,
}: {
  profileName?: string | null;
  onSubmitApplication: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Card>
      <h2 className="font-display text-xl font-semibold text-white">
        {profileName ? `Welcome, ${profileName}.` : "Welcome."} Request developer access.
      </h2>
      <p className="mt-2 text-sm text-juke-text-on-dark-secondary">
        Tell us what you&apos;re building. Approval unlocks server keys; hosted iframes work without one.
      </p>
      <form className="mt-4 space-y-3" onSubmit={onSubmitApplication}>
        <Field label="Project" name="projectName" required />
        <Field label="Website" name="websiteUrl" type="url" />
        <TextArea label="Use case" name="useCase" required rows={3} />
        <button
          type="submit"
          className="mt-1 inline-flex h-11 w-full items-center justify-center rounded-full bg-juke-purple px-5 text-sm font-semibold text-white transition hover:bg-juke-purple-hover sm:w-auto"
        >
          Submit for review
        </button>
      </form>
    </Card>
  );
}

function PendingPanel({ profileName }: { profileName?: string | null }) {
  return (
    <Card>
      <h2 className="font-display text-xl font-semibold text-white">
        {profileName ? `Thanks, ${profileName}.` : "Thanks."} Your application is in review.
      </h2>
      <p className="mt-2 text-sm text-juke-text-on-dark-secondary">
        The hosted iframe works today without keys. Server APIs unlock once
        we approve your app.
      </p>
      <ul className="mt-5 space-y-2.5 text-sm text-juke-text-on-dark-secondary">
        <Bullet>Drop the iframe into any public space now.</Bullet>
        <Bullet>Keep Juke attribution visible.</Bullet>
        <Bullet>Come back here for keys after approval.</Bullet>
      </ul>
    </Card>
  );
}

function SuspendedPanel({ reason }: { reason?: string | null }) {
  return (
    <Card>
      <h2 className="font-display text-xl font-semibold text-white">Developer API paused</h2>
      <p className="mt-2 text-sm text-juke-text-on-dark-secondary">
        {reason ||
          "Hosted iframes keep working, but server APIs are disabled until access is restored."}
      </p>
    </Card>
  );
}

function ApprovedPanel({
  apps,
  onCreateApp,
  onCreateKey,
  onRotateKey,
  onRevokeKey,
}: {
  apps: DeveloperApp[];
  onCreateApp: (event: FormEvent<HTMLFormElement>) => void;
  onCreateKey: (appId: string, event: FormEvent<HTMLFormElement>) => void;
  onRotateKey: (appId: string, keyId: string) => void;
  onRevokeKey: (appId: string, keyId: string) => void;
}) {
  return (
    <>
      <Card>
        <h2 className="font-display text-xl font-semibold text-white">New app</h2>
        <p className="mt-2 text-sm text-juke-text-on-dark-secondary">
          An app scopes origins and groups keys. Production keys belong on
          your server.
        </p>
        <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={onCreateApp}>
          <Field label="Name" name="name" required />
          <Field label="Website" name="websiteUrl" type="url" />
          <Field
            label="Allowed origins"
            name="allowedOrigins"
            placeholder="https://example.com, https://app.example.com"
            hint="Full URLs only — must include https:// (or http:// for local). Comma-separated."
            className="sm:col-span-2"
          />
          <TextArea
            label="Description"
            name="description"
            rows={2}
            className="sm:col-span-2"
          />
          <button
            type="submit"
            className="mt-1 inline-flex h-11 items-center justify-center rounded-full bg-juke-orange px-5 text-sm font-semibold text-white transition hover:bg-juke-orange-hover sm:col-span-2 sm:justify-self-start sm:px-6"
          >
            Create app
          </button>
        </form>
      </Card>

      <div className="space-y-4">
        {apps.map((app) => (
          <AppCard
            key={app.id}
            app={app}
            onCreateKey={onCreateKey}
            onRotateKey={onRotateKey}
            onRevokeKey={onRevokeKey}
          />
        ))}
        {apps.length === 0 && (
          <Card>
            <p className="text-sm text-juke-text-on-dark-secondary">
              No apps yet.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}

function AppCard({
  app,
  onCreateKey,
  onRotateKey,
  onRevokeKey,
}: {
  app: DeveloperApp;
  onCreateKey: (appId: string, event: FormEvent<HTMLFormElement>) => void;
  onRotateKey: (appId: string, keyId: string) => void;
  onRevokeKey: (appId: string, keyId: string) => void;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="font-display text-lg font-semibold text-white">{app.name}</h3>
        <p className="text-xs text-juke-text-on-dark-tertiary">
          Created {formatDate(app.createdAt)}
        </p>
      </div>
      {app.description && (
        <p className="mt-2 text-sm text-juke-text-on-dark-secondary">
          {app.description}
        </p>
      )}
      {app.allowedOrigins.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {app.allowedOrigins.map((origin) => (
            <span
              key={origin}
              className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-xs text-juke-text-on-dark-secondary"
            >
              {origin}
            </span>
          ))}
        </div>
      )}

      <div className="mt-5 space-y-2.5">
        {app.keys.map((key) => (
          <div
            key={key.keyId}
            className="rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate font-medium text-white">
                  {key.name}
                </span>
                <Chip
                  tone={key.status === "active" ? "success" : "muted"}
                  size="sm"
                >
                  {key.status}
                </Chip>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={key.status !== "active"}
                  onClick={() => onRotateKey(app.id, key.keyId)}
                  className="h-11 rounded-full border border-white/10 px-4 text-xs font-medium text-white transition hover:border-juke-purple/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Rotate
                </button>
                <button
                  type="button"
                  disabled={key.status !== "active"}
                  onClick={() => onRevokeKey(app.id, key.keyId)}
                  className="h-11 rounded-full border border-white/10 px-4 text-xs font-medium text-white transition hover:border-juke-orange/60 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Revoke
                </button>
              </div>
            </div>
            <code className="mt-2.5 block overflow-x-auto rounded-lg bg-black/30 px-3 py-2 text-xs text-juke-text-on-dark-secondary">
              {maskDeveloperKey(key)}
            </code>
            <p className="mt-1.5 text-xs text-juke-text-on-dark-tertiary">
              Created {formatDate(key.createdAt)}
              {key.lastUsedAt && ` · Last used ${formatDate(key.lastUsedAt)}`}
            </p>
          </div>
        ))}
        {app.keys.length === 0 && (
          <p className="rounded-xl border border-dashed border-white/10 px-4 py-3 text-xs text-juke-text-on-dark-tertiary">
            No keys yet.
          </p>
        )}
      </div>

      <form
        className="mt-4 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => onCreateKey(app.id, event)}
      >
        <input
          name="keyName"
          required
          placeholder="New key name (e.g. Production server)"
          className="h-11 flex-1 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm text-white outline-none transition placeholder:text-juke-text-on-dark-tertiary focus:border-juke-purple"
        />
        <button
          type="submit"
          className="inline-flex h-11 items-center justify-center rounded-full bg-juke-purple px-5 text-sm font-semibold text-white transition hover:bg-juke-purple-hover"
        >
          Create key
        </button>
      </form>

      <AppBotsPanel appId={app.id} />
    </Card>
  );
}

function SecretReveal({
  response,
  onReveal,
  onDismiss,
}: {
  response: CreateDeveloperKeyResponse;
  onReveal: () => void;
  onDismiss: () => void;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(response.secret);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  return (
    <div className="rounded-2xl border border-juke-orange/40 bg-juke-orange/10 p-5">
      <h2 className="font-display text-lg font-semibold text-white">Copy this key now</h2>
      <p className="mt-1.5 text-sm text-orange-50/80">
        Shown once. Lose it and you&apos;ll need to rotate.
      </p>
      {response.secret ? (
        <code className="mt-3 block overflow-x-auto rounded-lg bg-black/40 px-3 py-2.5 text-xs text-white">
          {response.secret}
        </code>
      ) : (
        <p className="mt-3 rounded-lg bg-black/30 px-3 py-2.5 text-xs text-orange-50/80">
          Secret is sealed. Use the reveal token from this session to view it once.
        </p>
      )}
      <div className="mt-3 flex gap-2">
        {response.secret ? (
          <button
            type="button"
            onClick={copySecret}
            className="inline-flex h-10 items-center justify-center rounded-full bg-juke-orange px-4 text-sm font-semibold text-white transition hover:bg-juke-orange-hover"
          >
            {copyState === "copied"
              ? "Copied"
              : copyState === "failed"
                ? "Copy failed"
                : "Copy"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onReveal}
            disabled={!response.revealToken}
            className="inline-flex h-10 items-center justify-center rounded-full bg-juke-orange px-4 text-sm font-semibold text-white transition hover:bg-juke-orange-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            Reveal once
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-10 items-center justify-center rounded-full border border-white/15 px-4 text-sm font-medium text-white transition hover:border-white/30"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function IntegrationGuide() {
  return (
    <Card>
      <h2 className="font-display text-lg font-semibold text-white">Quickstart</h2>
      <div className="mt-4 space-y-4">
        <Snippet title="Iframe" code={SNIPPETS.iframe} />
        <Snippet title="Server API" code={SNIPPETS.server} />
        <p className="text-xs text-juke-text-on-dark-tertiary">
          Agent docs:{" "}
          <a className="text-juke-orange underline" href="/llms.txt">
            llms.txt
          </a>{" "}
          ·{" "}
          <a className="text-juke-purple underline" href="/SKILL.md">
            SKILL.md
          </a>
        </p>
      </div>
    </Card>
  );
}

function PreviewControls({
  isSignedIn,
  previewStatus,
  onChange,
}: {
  isSignedIn: boolean;
  previewStatus: PreviewStatus;
  onChange: (status: PreviewStatus) => void;
}) {
  const options: { value: PreviewStatus; label: string }[] = [
    { value: null, label: "Out" },
    { value: "none", label: "None" },
    { value: "pending", label: "Pending" },
    { value: "approved", label: "Approved" },
    { value: "suspended", label: "Suspended" },
  ];
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-3 z-40 flex justify-center px-3">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/10 bg-black/70 px-1.5 py-1 text-xs text-juke-text-on-dark-secondary backdrop-blur">
        <span className="px-2 text-juke-text-on-dark-tertiary">dev</span>
        {options.map((option) => {
          const active =
            option.value === previewStatus ||
            (!option.value && !isSignedIn && !previewStatus);
          return (
            <button
              key={option.label}
              type="button"
              onClick={() => onChange(option.value)}
              className={`rounded-full px-2.5 py-1 transition ${
                active
                  ? "bg-white/15 text-white"
                  : "hover:bg-white/5 hover:text-white"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-2xl border border-juke-border/60 bg-juke-surface p-5 sm:p-6 ${className}`}
    >
      {children}
    </section>
  );
}

function Chip({
  children,
  tone,
  size = "md",
}: {
  children: ReactNode;
  tone: "success" | "warning" | "muted";
  size?: "sm" | "md";
}) {
  const palette =
    tone === "success"
      ? "bg-emerald-400/10 text-emerald-200"
      : tone === "warning"
        ? "bg-juke-orange/15 text-orange-200"
        : "bg-white/[0.06] text-juke-text-on-dark-secondary";
  const sizing = size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs";
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${sizing} ${palette}`}
    >
      {children}
    </span>
  );
}

function Banner({
  tone,
  children,
}: {
  tone: "error" | "info";
  children: ReactNode;
}) {
  const palette =
    tone === "error"
      ? "border-red-400/40 bg-red-500/10 text-red-50"
      : "border-white/10 bg-white/[0.04] text-juke-text-on-dark-secondary";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`rounded-xl border px-4 py-2.5 text-sm ${palette}`}
    >
      {children}
    </div>
  );
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <CheckIcon className="mt-0.5 h-4 w-4 shrink-0 text-juke-purple" />
      <span>{children}</span>
    </li>
  );
}

function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 10.5l3.5 3.5L16 6" />
    </svg>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  placeholder,
  hint,
  className = "",
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs font-medium text-juke-text-on-dark-secondary">
        {label}
        {required && <span className="ml-0.5 text-juke-orange">*</span>}
      </span>
      <input
        name={name}
        type={type}
        required={required}
        placeholder={placeholder}
        className="mt-1.5 h-11 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3.5 text-sm text-white outline-none transition placeholder:text-juke-text-on-dark-tertiary focus:border-juke-orange"
      />
      {hint && (
        <span className="mt-1 block text-xs text-juke-text-on-dark-tertiary">
          {hint}
        </span>
      )}
    </label>
  );
}

function TextArea({
  label,
  name,
  rows = 3,
  required = false,
  className = "",
}: {
  label: string;
  name: string;
  rows?: number;
  required?: boolean;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="text-xs font-medium text-juke-text-on-dark-secondary">
        {label}
        {required && <span className="ml-0.5 text-juke-orange">*</span>}
      </span>
      <textarea
        name={name}
        required={required}
        rows={rows}
        className="mt-1.5 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-sm text-white outline-none transition placeholder:text-juke-text-on-dark-tertiary focus:border-juke-orange"
      />
    </label>
  );
}

function Snippet({ title, code }: { title: string; code: string }) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-juke-text-on-dark-secondary">
        {title}
      </p>
      <pre className="overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 text-[11px] leading-5 text-juke-text-on-dark-secondary">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/**
 * Read-only panel showing bots registered under an app. Polls every 15 s
 * while any bot has a pending_approval signer. Uses `createDeveloperApiClient()`
 * to pick up the module-level session — the backend endpoint will 404 until
 * WS2 ships, so errors are silently swallowed and the panel stays hidden.
 */
function AppBotsPanel({ appId }: { appId: string }) {
  const clientRef = useRef<DeveloperApiClient | null>(null);
  const [bots, setBots] = useState<DeveloperBot[] | null>(null);

  if (!clientRef.current) clientRef.current = createDeveloperApiClient();

  const hasPending =
    bots?.some((b) => b.signerStatus === "pending_approval") ?? false;

  const fetchBots = useCallback(async () => {
    try {
      const next = await clientRef.current!.listBots(appId);
      setBots(next);
    } catch {
      setBots((prev) => prev ?? []);
    }
  }, [appId]);

  useEffect(() => {
    void fetchBots();
  }, [fetchBots]);

  useEffect(() => {
    if (!hasPending) return;
    const id = setInterval(() => void fetchBots(), 15_000);
    return () => clearInterval(id);
  }, [hasPending, fetchBots]);

  if (bots === null) return null;

  return (
    <div className="mt-5 border-t border-white/[0.06] pt-4">
      <p className="mb-2 text-xs font-medium text-juke-text-on-dark-secondary">
        Bots{bots.length > 0 ? ` (${bots.length})` : ""}
      </p>
      {bots.length === 0 ? (
        <Snippet
          title="Register a bot (server-side)"
          code={`curl -X POST https://your-api-host.example.com/v1/developer/bots \\
  -H "X-Juke-Api-Key: $JUKE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"fid": 123456, "label": "my-bot"}'`}
        />
      ) : (
        <div className="space-y-2.5">
          {bots.map((bot) => (
            <BotRow key={bot.id} bot={bot} />
          ))}
        </div>
      )}
    </div>
  );
}

function BotRow({ bot }: { bot: DeveloperBot }) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  // Validate approvalUrl is https: before using it as a link or in the
  // clipboard — guards against a compromised backend injecting javascript: URLs.
  const safeApprovalUrl = safeImageUrl(bot.approvalUrl);

  useEffect(() => {
    if (!safeApprovalUrl) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(safeApprovalUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 160,
      color: { dark: "#0f0f23", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [safeApprovalUrl]);

  async function copyUrl() {
    if (!safeApprovalUrl) return;
    try {
      await navigator.clipboard.writeText(safeApprovalUrl);
      setCopyState("copied");
    } catch {
      // clipboard denied — leave button as-is
    }
    window.setTimeout(() => setCopyState("idle"), 1800);
  }

  const statusTone: "success" | "warning" | "muted" =
    bot.signerStatus === "approved"
      ? "success"
      : bot.signerStatus === "pending_approval"
        ? "warning"
        : "muted"; // revoked | fid_mismatch | null

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-white">{bot.label}</span>
          <span className="shrink-0 text-xs text-juke-text-on-dark-tertiary">
            FID {bot.fid}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Chip tone="muted" size="sm">
            {bot.authMode === "app_key" ? "managed" : "custody-env"}
          </Chip>
          <Chip tone={statusTone} size="sm">
            {bot.signerStatus ?? "none"}
          </Chip>
        </div>
      </div>

      {bot.signerStatus === "pending_approval" && safeApprovalUrl && (
        <div className="mt-3 space-y-2.5">
          {qrDataUrl && (
            <img
              src={qrDataUrl}
              alt="Scan with the bot account's Farcaster app"
              width={160}
              height={160}
              style={{ width: 160, height: 160 }}
              className="rounded-xl bg-white p-1"
            />
          )}
          <p className="text-xs text-juke-text-on-dark-secondary">
            Open this link from the bot account&apos;s Farcaster app to approve
            the signer. Waiting for approval…
          </p>
          <div className="flex flex-wrap gap-2">
            <a
              href={safeApprovalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-9 items-center rounded-full border border-white/15 px-3 text-xs font-medium text-white/80 transition hover:bg-white/5"
            >
              Open in Farcaster
            </a>
            <button
              type="button"
              onClick={copyUrl}
              className="inline-flex h-9 items-center rounded-full border border-white/15 px-3 text-xs font-medium text-white/80 transition hover:bg-white/5"
            >
              {copyState === "copied" ? "Copied" : "Copy link"}
            </button>
          </div>
        </div>
      )}

      {(bot.signerStatus === "revoked" || bot.signerStatus === "fid_mismatch") && (
        <p className="mt-2 text-xs text-juke-text-on-dark-secondary">
          {bot.signerStatus === "fid_mismatch"
            ? "Wrong account approved. Re-register via POST /v1/developer/bots/{id}/signer to get a fresh keypair."
            : "Signer revoked. Re-register to recover."}
        </p>
      )}
    </div>
  );
}

function previewKeyResponse(name: string): CreateDeveloperKeyResponse {
  const keyId = `preview${Date.now().toString(16)}`;
  const shouldSealForReveal = /\breveal\b/i.test(name);
  return {
    key: {
      appId: "app_preview_1",
      keyId,
      name: name || "Server key",
      status: "active",
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    },
    secret: shouldSealForReveal ? "" : previewSecret(keyId),
    revealToken: crypto.randomUUID().replace(/-/g, ""),
  };
}

function previewSecret(keyId: string): string {
  return `jk_sec_live_${keyId}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function confirmKeyAction(action: "rotate" | "revoke", keyName: string): boolean {
  const verb = action === "rotate" ? "Rotate" : "Revoke";
  return window.confirm(`${verb} "${keyName}"? This can break live integrations.`);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}
