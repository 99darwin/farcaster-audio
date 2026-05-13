"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DeveloperApiError,
  createDeveloperApiClient,
  type DeveloperAccessUser,
  type DeveloperApiClient,
  type DeveloperStatus,
} from "@/lib/developer-api";
import { SignerApprovalPrompt } from "../signer-approval-prompt";

type LoadState = "idle" | "loading" | "ready" | "error";

const STATUSES: DeveloperStatus[] = ["pending", "approved", "suspended", "none"];

const STATUS_LABEL: Record<DeveloperStatus | "all", string> = {
  all: "All",
  pending: "Pending",
  approved: "Approved",
  suspended: "Suspended",
  none: "No access",
};

type DeveloperAdminDashboardProps = {
  mockUsers?: DeveloperAccessUser[];
};

export function DeveloperAdminDashboard({ mockUsers }: DeveloperAdminDashboardProps) {
  const clientRef = useRef<DeveloperApiClient | null>(null);
  const signerAbortRef = useRef<AbortController | null>(null);
  const [signerApprovalUrl, setSignerApprovalUrl] = useState<string | null>(
    null,
  );
  const mockMode = Boolean(mockUsers);
  const [mockSourceUsers, setMockSourceUsers] = useState<DeveloperAccessUser[]>(
    mockUsers ?? [],
  );
  const [users, setUsers] = useState<DeveloperAccessUser[]>(
    filterMockUsers(mockUsers ?? [], "pending"),
  );
  const [filter, setFilter] = useState<DeveloperStatus | "all">("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [loadState, setLoadState] = useState<LoadState>(
    mockUsers ? "ready" : "idle",
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filteredUsers = useMemo(
    () => filterBySearchQuery(users, searchQuery),
    [users, searchQuery],
  );

  // `users` is already filtered by status server-side (or client-side in
  // mock mode), so this count reflects what the admin actually has on
  // their plate after applying the status filter. We surface it on the
  // toolbar even when search narrows the visible rows.
  const pendingCount = useMemo(
    () =>
      users.filter((u) => u.developerAccessStatus === "pending").length,
    [users],
  );

  if (!clientRef.current) clientRef.current = createDeveloperApiClient();

  useEffect(() => {
    return () => {
      signerAbortRef.current?.abort();
      signerAbortRef.current = null;
    };
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
    signerAbortRef.current?.abort();
    const abort = new AbortController();
    signerAbortRef.current = abort;

    setPendingAction("Opening Farcaster");
    setError(null);
    setSignerApprovalUrl(null);
    try {
      const { channelToken, url } = await clientRef.current!.startSiwfFlow();
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
      await loadUsers();
    } catch (err) {
      if (abort.signal.aborted) return;
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
              {signerApprovalUrl ? (
                <SignerApprovalPrompt
                  approvalUrl={signerApprovalUrl}
                  onCancel={cancelSignIn}
                />
              ) : (
                <button
                  type="button"
                  onClick={signIn}
                  className="mt-5 inline-flex h-11 items-center justify-center rounded-full bg-juke-orange px-5 text-sm font-semibold text-white transition hover:bg-juke-orange-hover"
                >
                  Sign in
                </button>
              )}
            </Card>
          )}

          {signedIn && (
            <>
              <Card>
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-baseline gap-3">
                      <h2 className="text-xl font-semibold text-white">
                        {STATUS_LABEL[filter]}
                      </h2>
                      {filter === "pending" && pendingCount > 0 && (
                        <span className="text-sm text-juke-text-on-dark-tertiary">
                          {pendingCount} awaiting review
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={loadUsers}
                      className="h-9 self-start rounded-full border border-white/10 px-3 text-xs font-medium text-juke-text-on-dark-secondary transition hover:border-white/25 hover:text-white sm:self-auto"
                    >
                      Refresh
                    </button>
                  </div>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                    <SearchInput
                      value={searchQuery}
                      onChange={setSearchQuery}
                      placeholder="Search FID, username, or display name"
                    />
                    <div className="flex flex-wrap gap-2">
                      <FilterButton
                        active={filter === "all"}
                        onClick={() => setFilter("all")}
                      >
                        All
                      </FilterButton>
                      {STATUSES.map((status) => (
                        <FilterButton
                          key={status}
                          active={filter === status}
                          onClick={() => setFilter(status)}
                        >
                          {STATUS_LABEL[status]}
                        </FilterButton>
                      ))}
                    </div>
                  </div>
                </div>
              </Card>

              <div className="space-y-3">
                {filteredUsers.map((user) => (
                  <AccessCard
                    key={user.fid}
                    user={user}
                    onSetAccess={setAccess}
                  />
                ))}
                {filteredUsers.length === 0 && loadState !== "loading" && (
                  <Card>
                    <p className="text-sm text-juke-text-on-dark-secondary">
                      {searchQuery
                        ? `No matches for "${searchQuery}".`
                        : "No developer applications match this view."}
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
  const submittedRelative = application?.createdAt
    ? relativeTime(application.createdAt)
    : null;
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
            {user.username && ` · @${user.username}`}
            {submittedRelative && ` · Submitted ${submittedRelative}`}
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
                  {application.websiteUrl ? (
                    <a
                      href={application.websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-juke-orange underline-offset-2 hover:underline"
                    >
                      {application.websiteUrl}
                    </a>
                  ) : (
                    "Not provided"
                  )}
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
              No application on file.
            </p>
          )}
        </div>

        <AccessActions user={user} onSetAccess={onSetAccess} />
      </div>
    </Card>
  );
}

/**
 * Buttons rendered are contextual to the user's current status. Destructive
 * transitions (suspend, reject) gate behind a confirmation; constructive
 * transitions (approve, restore) are one-click.
 */
function AccessActions({
  user,
  onSetAccess,
}: {
  user: DeveloperAccessUser;
  onSetAccess: (user: DeveloperAccessUser, status: DeveloperStatus) => void;
}) {
  function confirmedSetAccess(status: DeveloperStatus, prompt: string) {
    if (!window.confirm(prompt)) return;
    onSetAccess(user, status);
  }

  const status = user.developerAccessStatus;
  const label = user.displayName || user.username || `FID ${user.fid}`;

  if (status === "pending") {
    return (
      <div className="flex flex-wrap gap-2 lg:justify-end">
        <ActionButton onClick={() => onSetAccess(user, "approved")} tone="primary">
          Approve
        </ActionButton>
        <ActionButton
          onClick={() =>
            confirmedSetAccess(
              "none",
              `Reject ${label}'s application? They can re-apply.`,
            )
          }
          tone="danger"
        >
          Reject
        </ActionButton>
      </div>
    );
  }

  if (status === "approved") {
    return (
      <div className="flex flex-wrap gap-2 lg:justify-end">
        <ActionButton
          onClick={() =>
            confirmedSetAccess(
              "suspended",
              `Suspend ${label}? Their API keys stop working immediately.`,
            )
          }
          tone="danger"
        >
          Suspend
        </ActionButton>
      </div>
    );
  }

  if (status === "suspended") {
    return (
      <div className="flex flex-wrap gap-2 lg:justify-end">
        <ActionButton onClick={() => onSetAccess(user, "approved")} tone="primary">
          Restore
        </ActionButton>
      </div>
    );
  }

  // status === "none"
  return (
    <div className="flex flex-wrap gap-2 lg:justify-end">
      <ActionButton onClick={() => onSetAccess(user, "approved")} tone="primary">
        Grant access
      </ActionButton>
    </div>
  );
}

/**
 * Lightweight search box. Empty value clears; Esc clears + blurs.
 */
function SearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative flex-1">
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("");
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder={placeholder}
        className="h-11 w-full rounded-full border border-white/10 bg-white/[0.03] px-4 text-sm text-white placeholder:text-juke-text-on-dark-tertiary transition focus:border-juke-purple/60 focus:outline-none"
        aria-label="Search users"
      />
    </div>
  );
}

function filterBySearchQuery(
  users: DeveloperAccessUser[],
  query: string,
): DeveloperAccessUser[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return users;
  return users.filter((user) => {
    const fid = String(user.fid);
    const username = (user.username || "").toLowerCase();
    const displayName = (user.displayName || "").toLowerCase();
    return (
      fid.includes(trimmed) ||
      username.includes(trimmed) ||
      displayName.includes(trimmed)
    );
  });
}

function relativeTime(iso: string): string {
  const date = new Date(iso);
  const t = date.getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = Date.now() - t;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "just now";
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
