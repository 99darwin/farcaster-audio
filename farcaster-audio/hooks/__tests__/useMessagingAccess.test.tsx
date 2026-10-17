import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import * as messagesApi from "@/services/messagesApi";
import * as signerLink from "@/services/signerLink";
import { useAuthStore } from "@/stores/authStore";
import { useMessageStore } from "@/stores/messageStore";
import type { MessagingStatus } from "@/types/messages";
import {
  describeEnableError,
  type MessagingEnableReason,
  useMessagingAccess,
  useMessagingTokenStore,
} from "../useMessagingAccess";

const VIEWER = { fid: 42, username: "alice", custody_address: "0xabc" };

jest.mock("@/stores/authStore", () => {
  const { create } = jest.requireActual<typeof import("zustand")>("zustand");
  return { useAuthStore: create(() => ({ user: null as unknown })) };
});

jest.mock("@/services/messagesApi", () => {
  const actual = jest.requireActual<typeof import("@/services/messagesApi")>(
    "@/services/messagesApi",
  );
  return {
    ...actual,
    getMessagingStatus: jest.fn(),
    enableMessaging: jest.fn(),
  };
});

jest.mock("@/services/signerLink", () => {
  const actual = jest.requireActual<typeof import("@/services/signerLink")>(
    "@/services/signerLink",
  );
  return { ...actual, signMessagingToken: jest.fn() };
});

const mockStatus = jest.mocked(messagesApi.getMessagingStatus);
const mockEnable = jest.mocked(messagesApi.enableMessaging);
const mockSign = jest.mocked(signerLink.signMessagingToken);

function status(overrides: Partial<MessagingStatus>): MessagingStatus {
  return {
    enabled: true,
    signer_status: "ready",
    token_status: "active",
    expires_at: "2030-01-01T00:00:00Z",
    ...overrides,
  };
}

const SIGNED = {
  dc_auth_request: {
    method: "generateToken" as const,
    params: { timestamp: 1, expiresAt: 2 },
  },
  dc_auth_signature: "eip191:sig",
};

describe("useMessagingAccess", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useMessagingTokenStore.setState({ snapshot: null, inFlight: null });
    useMessageStore.getState().setAccessError(null);
    useMessageStore.getState().setAvailability("unknown");
    useAuthStore.setState({ user: VIEWER } as never);
  });

  it("is ready when the stored token is active", async () => {
    mockStatus.mockResolvedValue(status({}));
    const { result } = renderHook(() => useMessagingAccess());
    expect(result.current.state).toBe("checking");
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.expiresAt).toBe("2030-01-01T00:00:00Z");
  });

  it("shares one status request across surfaces", async () => {
    mockStatus.mockResolvedValue(status({}));
    const first = renderHook(() => useMessagingAccess());
    const second = renderHook(() => useMessagingAccess());
    await waitFor(() => expect(second.result.current.state).toBe("ready"));
    expect(first.result.current.state).toBe("ready");
    expect(mockStatus).toHaveBeenCalledTimes(1);
  });

  it.each<["missing" | "expired", MessagingEnableReason]>([
    ["missing", "missing"],
    ["expired", "expired"],
  ])("needs enable when the token is %s", async (tokenStatus, reason) => {
    mockStatus.mockResolvedValue(
      status({ token_status: tokenStatus, signer_status: "not_linked", expires_at: null }),
    );
    const { result } = renderHook(() => useMessagingAccess());
    await waitFor(() => expect(result.current.state).toBe("needs_enable"));
    expect(result.current.enableReason).toBe(reason);
  });

  it("a later token 403 overrides a cached active status", async () => {
    mockStatus.mockResolvedValue(status({}));
    const { result } = renderHook(() => useMessagingAccess());
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => useMessageStore.getState().setAccessError("token_rejected"));
    expect(result.current.state).toBe("needs_enable");
    expect(result.current.enableReason).toBe("rejected");
  });

  it("offers retry when the probe fails or the token is unreadable", async () => {
    mockStatus.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useMessagingAccess());
    await waitFor(() => expect(result.current.state).toBe("error"));

    // A stored row the server cannot decrypt is not usable.
    mockStatus.mockResolvedValueOnce(
      status({ token_status: "active", signer_status: "unavailable" }),
    );
    await act(() => result.current.refresh());
    expect(result.current.state).toBe("error");

    mockStatus.mockResolvedValueOnce(status({}));
    await act(() => result.current.refresh());
    expect(result.current.state).toBe("ready");
  });

  it("marks the feature unavailable when the flag is off", async () => {
    mockStatus.mockResolvedValue(
      status({ enabled: false, signer_status: null, token_status: null, expires_at: null }),
    );
    renderHook(() => useMessagingAccess());
    await waitFor(() =>
      expect(useMessageStore.getState().availability).toBe("unavailable"),
    );
  });

  it("enable signs with the viewer's custody, stores the token and clears errors", async () => {
    mockStatus.mockResolvedValue(status({ token_status: "missing", expires_at: null }));
    mockSign.mockResolvedValue(SIGNED);
    mockEnable.mockResolvedValue({ token_status: "active", expires_at: "2031-01-01T00:00:00Z" });
    const { result } = renderHook(() => useMessagingAccess());
    await waitFor(() => expect(result.current.state).toBe("needs_enable"));
    act(() => useMessageStore.getState().setAccessError("token_missing"));

    let isEnabled = false;
    await act(async () => {
      isEnabled = await result.current.enable("the phrase");
    });

    expect(isEnabled).toBe(true);
    expect(mockSign).toHaveBeenCalledWith({
      phrase: "the phrase",
      fid: 42,
      custodyAddress: "0xabc",
    });
    expect(mockEnable).toHaveBeenCalledWith(SIGNED);
    expect(result.current.state).toBe("ready");
    expect(result.current.expiresAt).toBe("2031-01-01T00:00:00Z");
    expect(useMessageStore.getState().accessError).toBeNull();
  });

  it("enable surfaces a phrase-free error and stays gated", async () => {
    mockStatus.mockResolvedValue(status({ token_status: "missing", expires_at: null }));
    mockSign.mockResolvedValue(SIGNED);
    mockEnable.mockRejectedValue(new messagesApi.EnableMessagingError("invalid_signature"));
    const { result } = renderHook(() => useMessagingAccess());
    await waitFor(() => expect(result.current.state).toBe("needs_enable"));

    let isEnabled = true;
    await act(async () => {
      isEnabled = await result.current.enable("secret words here");
    });

    expect(isEnabled).toBe(false);
    expect(result.current.state).toBe("needs_enable");
    expect(result.current.enableError).toMatch(/doesn't control this Farcaster account/);
    expect(result.current.enableError).not.toContain("secret");
  });

  it("drops the cached status on sign-out", async () => {
    mockStatus.mockResolvedValue(status({}));
    renderHook(() => useMessagingAccess());
    await waitFor(() => expect(useMessagingTokenStore.getState().snapshot).not.toBeNull());
    act(() => useAuthStore.setState({ user: null } as never));
    expect(useMessagingTokenStore.getState().snapshot).toBeNull();
  });
});

describe("describeEnableError", () => {
  it("uses the SignerLinkError copy and falls back for unknown errors", () => {
    expect(
      describeEnableError(new signerLink.SignerLinkError("phrase_mismatch", "Wrong phrase.")),
    ).toBe("Wrong phrase.");
    expect(describeEnableError(new Error("boom"))).toBe("Something went wrong. Try again.");
  });
});
