import { ApiFetchError } from "@/lib/api/client";
import { MESSAGING_DISABLED } from "@/lib/api/messages";
import type { MessagingStatus } from "@/lib/api/messages.types";
import { createBackgroundInboxPoll, type BackgroundInboxPollDeps } from "@/lib/messages/background-poll";
import type { MessagingAvailability } from "@/lib/stores/messageStore";

const INTERVAL_MS = 60_000;

function status(token_status: MessagingStatus["token_status"], enabled = true): MessagingStatus {
  return { enabled, signer_status: "ready", token_status, expires_at: null };
}

function setup(overrides: Partial<BackgroundInboxPollDeps> = {}) {
  let availability: MessagingAvailability = "unknown";
  let fid: number | null = 7;
  const deps = {
    getStatus: jest.fn(async () => status("active")),
    loadInbox: jest.fn(async () => {}),
    getViewerFid: jest.fn(() => fid),
    getAvailability: jest.fn(() => availability),
    setAvailability: jest.fn((next: MessagingAvailability) => {
      availability = next;
    }),
    isVisible: jest.fn(() => true),
    intervalMs: INTERVAL_MS,
    ...overrides,
  };
  return {
    deps,
    poll: createBackgroundInboxPoll(deps),
    setAvailability: (next: MessagingAvailability) => (availability = next),
    setFid: (next: number | null) => (fid = next),
  };
}

describe("background inbox poll gating", () => {
  it.each(["missing", "expired"] as const)("never loads the inbox when the token is %s", async (token) => {
    const { deps, poll } = setup({ getStatus: jest.fn(async () => status(token)) });
    await poll.tick();
    await poll.tick();
    expect(deps.loadInbox).not.toHaveBeenCalled();
    expect(deps.setAvailability).toHaveBeenCalledWith("token_required");
  });

  it("keeps skipping the inbox while the token is required", async () => {
    const { deps, poll, setAvailability } = setup({ getStatus: jest.fn(async () => status("missing")) });
    await poll.tick();
    setAvailability("token_required");
    await poll.tick();
    // Re-checks status (the user may have enabled meanwhile) but never polls blind.
    expect(deps.getStatus).toHaveBeenCalledTimes(2);
    expect(deps.loadInbox).not.toHaveBeenCalled();
  });

  it("checks status once per viewer, then polls the inbox", async () => {
    const { deps, poll, setFid } = setup();
    await poll.tick();
    await poll.tick();
    expect(deps.getStatus).toHaveBeenCalledTimes(1);
    expect(deps.loadInbox).toHaveBeenCalledTimes(2);
    setFid(8);
    await poll.tick();
    expect(deps.getStatus).toHaveBeenCalledTimes(2);
  });

  it("re-confirms after the store reports a token error", async () => {
    const { deps, poll, setAvailability } = setup();
    await poll.tick();
    setAvailability("token_required");
    jest.mocked(deps.getStatus).mockResolvedValueOnce(status("expired"));
    await poll.tick();
    expect(deps.getStatus).toHaveBeenCalledTimes(2);
    expect(deps.loadInbox).toHaveBeenCalledTimes(1);
  });

  it("stops for disabled messaging, signed-out viewers and hidden tabs", async () => {
    const disabled = setup({ getStatus: jest.fn(async () => status(null, false)) });
    await disabled.poll.tick();
    expect(disabled.deps.setAvailability).toHaveBeenCalledWith("disabled");
    await disabled.poll.tick();
    expect(disabled.deps.getStatus).toHaveBeenCalledTimes(1);
    expect(disabled.deps.loadInbox).not.toHaveBeenCalled();

    const flagged = setup({ getStatus: jest.fn().mockRejectedValue(new ApiFetchError(404, MESSAGING_DISABLED)) });
    await flagged.poll.tick();
    expect(flagged.deps.setAvailability).toHaveBeenCalledWith("disabled");

    const signedOut = setup();
    signedOut.setFid(null);
    await signedOut.poll.tick();
    expect(signedOut.deps.getStatus).not.toHaveBeenCalled();

    const hidden = setup({ isVisible: jest.fn(() => false) });
    await hidden.poll.tick();
    expect(hidden.deps.getStatus).not.toHaveBeenCalled();
  });

  it("fails closed when status can't be read, and retries next tick", async () => {
    const { deps, poll } = setup();
    jest.mocked(deps.getStatus).mockRejectedValueOnce(new ApiFetchError(503));
    await poll.tick();
    expect(deps.loadInbox).not.toHaveBeenCalled();
    await poll.tick();
    expect(deps.loadInbox).toHaveBeenCalledTimes(1);
  });

  it("ignores a status that resolves for a previous viewer", async () => {
    const { deps, poll, setFid } = setup();
    jest.mocked(deps.getStatus).mockImplementationOnce(async () => {
      setFid(8);
      return status("active");
    });
    await poll.tick();
    expect(deps.loadInbox).not.toHaveBeenCalled();
  });
});

describe("background inbox poll ref-counting", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("runs one timer for many retainers and stops after the last release", async () => {
    const { deps, poll } = setup();
    const releaseA = poll.retain();
    const releaseB = poll.retain();
    await jest.advanceTimersByTimeAsync(0);
    expect(deps.getStatus).toHaveBeenCalledTimes(1);
    expect(deps.loadInbox).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(deps.loadInbox).toHaveBeenCalledTimes(2);
    releaseA();
    releaseA();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS);
    expect(deps.loadInbox).toHaveBeenCalledTimes(3);
    releaseB();
    await jest.advanceTimersByTimeAsync(INTERVAL_MS * 3);
    expect(deps.loadInbox).toHaveBeenCalledTimes(3);
  });
});
