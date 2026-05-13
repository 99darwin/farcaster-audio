"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { SignerApprovalPrompt } from "../signer-approval-prompt";
import {
  DeveloperApiError,
  ReauthRequiredError,
  createDeveloperApiClient,
  maskDeveloperKey,
  type CreateDeveloperKeyResponse,
  type DeveloperApiClient,
  type DeveloperApp,
  type DeveloperDashboardResponse,
  type DeveloperStatus,
} from "@/lib/developer-api";

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
    Authorization: \`Bearer \${process.env.JUKE_USER_TOKEN}\`,
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
  const signerAbortRef = useRef<AbortController | null>(null);
  const [signerApprovalUrl, setSignerApprovalUrl] = useState<string | null>(
    null,
  );
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

  if (!clientRef.current) clientRef.current = createDeveloperApiClient();

  const profile = dashboard?.profile ?? null;
  const isSignedIn = Boolean(dashboard);

  useEffect(() => {
    if (previewStatus) return;
    const client = clientRef.current;
    if (!client?.currentSession) return;
    void loadDashboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewStatus]);

  // Abort any in-flight signer polling on unmount.
  useEffect(() => {
    return () => {
      signerAbortRef.current?.abort();
      signerAbortRef.current = null;
    };
  }, []);

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

  async function signIn() {
    // Abort any previous in-flight sign-in attempt.
    signerAbortRef.current?.abort();
    const abort = new AbortController();
    signerAbortRef.current = abort;

    setPendingAction("Opening Farcaster");
    setError(null);
    setPreviewStatus(null);
    setSignerApprovalUrl(null);

    try {
      const { channelToken, url } = await clientRef.current!.startSiwfFlow();
      // The url is a `farcaster://connect?...` deeplink. Render as
      // a QR for desktop (scan with phone) or as a tap-to-deeplink
      // button on mobile. The Farcaster client displays the domain
      // (juke.audio) at approval time — that's the SIWF guarantee
      // that lets users verify they're signing into the real site.
      setSignerApprovalUrl(url);
      setPendingAction("Waiting for Farcaster approval");

      const approved = await clientRef.current!.pollSiwfStatus(channelToken, {
        signal: abort.signal,
      });

      setPendingAction("Completing sign in");
      await clientRef.current!.completeSiwfLogin({
        message: approved.message,
        signature: approved.signature,
      });
      setSignerApprovalUrl(null);
      await loadDashboard();
    } catch (err) {
      if (abort.signal.aborted) return; // user cancelled — stay silent
      setError(errorMessage(err));
    } finally {
      if (signerAbortRef.current === abort) signerAbortRef.current = null;
      setPendingAction(null);
    }
  }

  function cancelSignIn() {
    signerAbortRef.current?.abort();
    signerAbortRef.current = null;
    setSignerApprovalUrl(null);
    setPendingAction(null);
  }

  function signOut() {
    clientRef.current!.signOut();
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
        // Step-up required: keep the session, prompt a fresh SIWN. The
        // user re-runs Sign in, then retries the action. We deliberately
        // do NOT auto-retry — the original action stays explicit.
        setError("Sign in again to continue.");
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
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
        <TopBar
          isSignedIn={isSignedIn}
          statusChip={statusChip}
          onSignOut={signOut}
        />

        <div className="mt-8 sm:mt-12 max-w-3xl">
          <h1 className="text-3xl font-bold leading-tight sm:text-4xl">
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

            {!dashboard && (
              <SignedOutPanel
                loadState={loadState}
                onSignIn={signIn}
                onCancelSignIn={cancelSignIn}
                isPolling={pendingAction === "Waiting for Farcaster approval"}
                approvalUrl={signerApprovalUrl}
              />
            )}

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
        className="flex items-center gap-2 text-sm font-semibold text-juke-text-on-dark-secondary transition hover:text-white"
      >
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-juke-orange text-white">
          J
        </span>
        Juke
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

function SignedOutPanel({
  loadState,
  onSignIn,
  onCancelSignIn,
  isPolling,
  approvalUrl,
}: {
  loadState: LoadState;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  isPolling: boolean;
  approvalUrl: string | null;
}) {
  return (
    <Card>
      <h2 className="text-xl font-semibold text-white">
        Sign in with Farcaster
      </h2>
      {isPolling ? (
        <SignerApprovalPrompt
          approvalUrl={approvalUrl}
          onCancel={onCancelSignIn}
        />
      ) : (
        <button
          type="button"
          onClick={onSignIn}
          className="mt-5 inline-flex h-11 items-center justify-center rounded-full bg-juke-orange px-5 text-sm font-semibold text-white transition hover:bg-juke-orange-hover"
        >
          Sign in
        </button>
      )}
      {loadState === "error" && !isPolling && (
        <p className="mt-3 text-xs text-juke-text-on-dark-tertiary">
          Sign in is required before requesting developer access.
        </p>
      )}
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
      <h2 className="text-xl font-semibold text-white">
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
      <h2 className="text-xl font-semibold text-white">
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
      <h2 className="text-xl font-semibold text-white">Developer API paused</h2>
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
        <h2 className="text-xl font-semibold text-white">New app</h2>
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
        <h3 className="text-lg font-semibold text-white">{app.name}</h3>
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
      <h2 className="text-lg font-semibold text-white">Copy this key now</h2>
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
      <h2 className="text-lg font-semibold text-white">Quickstart</h2>
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
      className={`rounded-2xl border border-white/10 bg-juke-surface/70 p-5 sm:p-6 ${className}`}
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
  className = "",
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  placeholder?: string;
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
