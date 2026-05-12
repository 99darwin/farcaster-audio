"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  DeveloperApiError,
  createDeveloperApiClient,
  isTrustedDeveloperSiwnMessage,
  parseDeveloperSiwnPayload,
  type DeveloperAccessUser,
  type DeveloperApiClient,
  type DeveloperStatus,
  type SiwnExpectation,
} from "@/lib/developer-api";

type LoadState = "idle" | "loading" | "ready" | "error";

const STATUSES: DeveloperStatus[] = ["pending", "approved", "suspended", "none"];

type DeveloperAdminDashboardProps = {
  mockUsers?: DeveloperAccessUser[];
};

export function DeveloperAdminDashboard({ mockUsers }: DeveloperAdminDashboardProps) {
  const clientRef = useRef<DeveloperApiClient | null>(null);
  const expectedSiwn = useRef<SiwnExpectation | null>(null);
  const mockMode = Boolean(mockUsers);
  const [mockSourceUsers, setMockSourceUsers] = useState<DeveloperAccessUser[]>(
    mockUsers ?? [],
  );
  const [users, setUsers] = useState<DeveloperAccessUser[]>(
    filterMockUsers(mockUsers ?? [], "pending"),
  );
  const [filter, setFilter] = useState<DeveloperStatus | "all">("pending");
  const [loadState, setLoadState] = useState<LoadState>(
    mockUsers ? "ready" : "idle",
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!clientRef.current) clientRef.current = createDeveloperApiClient();

  useEffect(() => {
    const handleMessage = async (event: MessageEvent) => {
      const expected = expectedSiwn.current;
      if (!expected) return;
      if (!isTrustedDeveloperSiwnMessage(event, expected)) return;
      const payload = parseDeveloperSiwnPayload(event.data);
      if (!payload) return;
      expectedSiwn.current = null;

      setPendingAction("Completing sign in");
      setError(null);
      try {
        await clientRef.current!.completeSiwn(payload);
        await loadUsers();
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setPendingAction(null);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (mockMode) {
      setUsers(filterMockUsers(mockSourceUsers, filter));
      return;
    }
    if (!clientRef.current?.currentSession) return;
    void loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function signIn() {
    setPendingAction("Opening Farcaster sign in");
    setError(null);
    try {
      const { nonce, popup } = await clientRef.current!.startSiwn();
      expectedSiwn.current = { nonce, source: popup };
    } catch (err) {
      expectedSiwn.current = null;
      setError(errorMessage(err));
    } finally {
      setPendingAction(null);
    }
  }

  function signOut() {
    if (mockMode) {
      window.location.href = "/developers/admin";
      return;
    }
    clientRef.current!.signOut();
    setUsers([]);
    setLoadState("idle");
    setError(null);
  }

  async function loadUsers() {
    if (mockMode) {
      setUsers(filterMockUsers(mockSourceUsers, filter));
      setLoadState("ready");
      return;
    }
    setLoadState("loading");
    setError(null);
    try {
      const next = await clientRef.current!.listDeveloperAccess(
        filter === "all" ? undefined : filter,
      );
      setUsers(next);
      setLoadState("ready");
    } catch (err) {
      if (err instanceof DeveloperApiError && err.status === 401) {
        setUsers([]);
        setLoadState("idle");
      } else {
        setError(errorMessage(err));
        setLoadState("error");
      }
    }
  }

  async function setAccess(user: DeveloperAccessUser, status: DeveloperStatus) {
    setPendingAction(`Setting FID ${user.fid} to ${status}`);
    setError(null);
    try {
      const updated = mockMode
        ? { ...user, developerAccessStatus: status }
        : await clientRef.current!.updateDeveloperAccess(user.fid, status);
      if (mockMode) {
        setMockSourceUsers((current) => {
          const next = current.map((item) =>
            item.fid === updated.fid ? { ...item, ...updated } : item,
          );
          setUsers(filterMockUsers(next, filter));
          return next;
        });
      } else {
        setUsers((current) =>
          current
            .map((item) =>
              item.fid === updated.fid ? { ...item, ...updated } : item,
            )
            .filter(
              (item) => filter === "all" || item.developerAccessStatus === filter,
            ),
        );
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPendingAction(null);
    }
  }

  const signedIn =
    mockMode || Boolean(clientRef.current.currentSession) || loadState === "ready";

  return (
    <main className="min-h-screen bg-juke-navy text-juke-text-on-dark">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10 lg:px-8">
        <div className="flex items-center justify-between gap-4">
          <a
            href="/developers"
            className="flex items-center gap-2 text-sm font-semibold text-juke-text-on-dark-secondary transition hover:text-white"
          >
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-juke-orange text-white">
              J
            </span>
            Developer dashboard
          </a>
          {signedIn && (
            <button
              type="button"
              onClick={signOut}
              className="rounded-full border border-white/10 px-3 py-1.5 text-sm text-juke-text-on-dark-secondary transition hover:border-white/25 hover:text-white"
            >
              {mockMode ? "Exit mock" : "Sign out"}
            </button>
          )}
        </div>

        <div className="mt-8 max-w-3xl">
          <h1 className="text-3xl font-bold leading-tight sm:text-4xl">
            Developer approvals
          </h1>
          <p className="mt-3 text-base text-juke-text-on-dark-secondary">
            Review builder requests, approve server API access, or pause keys when an integration needs attention.
          </p>
        </div>

        <div className="mt-8 space-y-4">
          {(error || pendingAction || loadState === "loading") && (
            <Banner tone={error ? "error" : "info"}>
              {error ?? pendingAction ?? "Loading applications..."}
            </Banner>
          )}

          {!signedIn && (
            <Card>
              <h2 className="text-xl font-semibold text-white">Admin sign in</h2>
              <p className="mt-2 text-sm text-juke-text-on-dark-secondary">
                Use a Juke admin account to approve or suspend developer access.
              </p>
              <button
                type="button"
                onClick={signIn}
                className="mt-5 inline-flex h-11 items-center justify-center rounded-full bg-juke-orange px-5 text-sm font-semibold text-white transition hover:bg-juke-orange-hover"
              >
                Sign in
              </button>
            </Card>
          )}

          {signedIn && (
            <>
              <Card>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-white">Applications</h2>
                    <p className="mt-1 text-sm text-juke-text-on-dark-secondary">
                      Showing {filter === "all" ? "all developer states" : filter}.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
                      All
                    </FilterButton>
                    {STATUSES.map((status) => (
                      <FilterButton
                        key={status}
                        active={filter === status}
                        onClick={() => setFilter(status)}
                      >
                        {status}
                      </FilterButton>
                    ))}
                    <button
                      type="button"
                      onClick={loadUsers}
                      className="h-11 rounded-full border border-white/10 px-4 text-xs font-medium text-white transition hover:border-juke-purple/60"
                    >
                      Refresh
                    </button>
                  </div>
                </div>
              </Card>

              <div className="space-y-3">
                {users.map((user) => (
                  <AccessCard key={user.fid} user={user} onSetAccess={setAccess} />
                ))}
                {users.length === 0 && loadState !== "loading" && (
                  <Card>
                    <p className="text-sm text-juke-text-on-dark-secondary">
                      No developer applications match this view.
                    </p>
                  </Card>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}

function filterMockUsers(
  users: DeveloperAccessUser[],
  filter: DeveloperStatus | "all",
): DeveloperAccessUser[] {
  return filter === "all"
    ? users
    : users.filter((user) => user.developerAccessStatus === filter);
}

function AccessCard({
  user,
  onSetAccess,
}: {
  user: DeveloperAccessUser;
  onSetAccess: (user: DeveloperAccessUser, status: DeveloperStatus) => void;
}) {
  const application = user.application;
  const label = user.displayName || user.username || `FID ${user.fid}`;
  return (
    <Card>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-white">{label}</h3>
            <Chip tone={statusTone(user.developerAccessStatus)}>
              {user.developerAccessStatus}
            </Chip>
          </div>
          <p className="mt-1 text-xs text-juke-text-on-dark-tertiary">
            FID {user.fid}
          </p>

          {application ? (
            <div className="mt-4 grid gap-3 text-sm text-juke-text-on-dark-secondary md:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-juke-text-on-dark-tertiary">
                  Project
                </p>
                <p className="mt-1 text-white">{application.projectName}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-juke-text-on-dark-tertiary">
                  Website
                </p>
                <p className="mt-1 break-words">
                  {application.websiteUrl || "Not provided"}
                </p>
              </div>
              <div className="md:col-span-2">
                <p className="text-xs font-medium text-juke-text-on-dark-tertiary">
                  Use case
                </p>
                <p className="mt-1 whitespace-pre-wrap">{application.useCase}</p>
              </div>
            </div>
          ) : (
            <p className="mt-4 text-sm text-juke-text-on-dark-tertiary">
              No application details were returned by the API.
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 lg:justify-end">
          <ActionButton onClick={() => onSetAccess(user, "approved")} tone="primary">
            Approve
          </ActionButton>
          <ActionButton onClick={() => onSetAccess(user, "suspended")} tone="danger">
            Suspend
          </ActionButton>
          <ActionButton onClick={() => onSetAccess(user, "none")} tone="secondary">
            Reset
          </ActionButton>
        </div>
      </div>
    </Card>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-juke-surface/70 p-5 sm:p-6">
      {children}
    </section>
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

function Chip({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "success" | "warning" | "muted";
}) {
  const palette =
    tone === "success"
      ? "bg-emerald-400/10 text-emerald-200"
      : tone === "warning"
        ? "bg-juke-orange/15 text-orange-200"
        : "bg-white/[0.06] text-juke-text-on-dark-secondary";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${palette}`}>
      {children}
    </span>
  );
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-11 rounded-full px-4 text-xs font-medium transition ${
        active
          ? "bg-juke-purple text-white"
          : "border border-white/10 text-juke-text-on-dark-secondary hover:border-white/25 hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function ActionButton({
  tone,
  onClick,
  children,
}: {
  tone: "primary" | "secondary" | "danger";
  onClick: () => void;
  children: ReactNode;
}) {
  const palette =
    tone === "primary"
      ? "bg-juke-orange text-white hover:bg-juke-orange-hover"
      : tone === "danger"
        ? "border border-juke-orange/50 text-white hover:bg-juke-orange/10"
        : "border border-white/10 text-juke-text-on-dark-secondary hover:border-white/25 hover:text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-11 rounded-full px-4 text-sm font-semibold transition ${palette}`}
    >
      {children}
    </button>
  );
}

function statusTone(status: DeveloperStatus): "success" | "warning" | "muted" {
  if (status === "approved") return "success";
  if (status === "suspended") return "warning";
  return "muted";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}
