import React from "react";
import { Text } from "react-native";
import { act, fireEvent, render } from "@testing-library/react-native";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { SignerGate } from "@/components/messages/SignerGate";
import type {
  MessagingEnableReason,
  UseMessagingAccessResult,
} from "@/hooks/useMessagingAccess";
import { useMessageStore } from "@/stores/messageStore";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("@/stores/authStore", () => ({
  useAuthStore: (selector: (state: unknown) => unknown) =>
    selector({ user: { fid: 42, username: "alice" } }),
}));

const mockEnable = jest.fn<(phrase: string) => Promise<boolean>>();
const mockRefresh = jest.fn<() => Promise<void>>();
let mockAccess: Partial<UseMessagingAccessResult> = {};

jest.mock("@/hooks/useMessagingAccess", () => ({
  useMessagingAccess: () => ({
    state: "ready",
    enableReason: null,
    expiresAt: null,
    isEnabling: false,
    enableError: null,
    enable: mockEnable,
    refresh: mockRefresh,
    clearEnableError: () => undefined,
    ...mockAccess,
  }),
}));

// The real step blocks screen capture and owns the phrase input; here it
// just reports its props and submits a fixed phrase.
jest.mock("@/components/auth/RecoveryPhraseStep", () => ({
  RecoveryPhraseStep: (props: {
    purpose?: string;
    username: string;
    error: string | null;
    onSubmit: (phrase: string) => void;
    onCancel: () => void;
  }) => {
    const { Pressable: MockPressable, Text: MockText } =
      jest.requireActual<typeof import("react-native")>("react-native");
    return (
      <>
        <MockText testID="phrase-purpose">{`${props.purpose}:${props.username}`}</MockText>
        {props.error ? <MockText>{props.error}</MockText> : null}
        <MockPressable testID="phrase-submit" onPress={() => props.onSubmit("w1 w2")} />
        <MockPressable testID="phrase-cancel" onPress={props.onCancel} />
      </>
    );
  },
}));

const Child = () => <Text>inbox</Text>;

describe("SignerGate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccess = {};
    useMessageStore.getState().setAvailability("unknown");
  });

  it("renders children when ready", () => {
    const { getByText } = render(<SignerGate><Child /></SignerGate>);
    expect(getByText("inbox")).toBeTruthy();
  });

  it.each<[MessagingEnableReason, string]>([
    ["missing", "Enable messages"],
    ["expired", "Messaging access expired"],
    ["rejected", "Enable messages again"],
  ])("shows the %s copy", (reason, title) => {
    mockAccess = { state: "needs_enable", enableReason: reason };
    const { getByTestId, getAllByText, queryByText } = render(
      <SignerGate><Child /></SignerGate>,
    );
    expect(getByTestId("signer-gate")).toBeTruthy();
    expect(getAllByText(title).length).toBeGreaterThan(0);
    expect(queryByText("inbox")).toBeNull();
  });

  it("runs the messages-only phrase step and returns on success", async () => {
    mockAccess = { state: "needs_enable", enableReason: "missing" };
    mockEnable.mockResolvedValue(true);
    const { getByTestId, queryByTestId } = render(<SignerGate><Child /></SignerGate>);

    fireEvent.press(getByTestId("signer-gate-enable"));
    expect(getByTestId("phrase-purpose").props.children).toBe("messages:alice");

    await act(async () => {
      fireEvent.press(getByTestId("phrase-submit"));
    });
    expect(mockEnable).toHaveBeenCalledWith("w1 w2");
    expect(queryByTestId("phrase-purpose")).toBeNull();
  });

  it("keeps the phrase step open with the error when enable fails", async () => {
    mockAccess = {
      state: "needs_enable",
      enableReason: "missing",
      enableError: "That phrase doesn't control this Farcaster account.",
    };
    mockEnable.mockResolvedValue(false);
    const { getByTestId, getByText } = render(<SignerGate><Child /></SignerGate>);
    fireEvent.press(getByTestId("signer-gate-enable"));
    await act(async () => {
      fireEvent.press(getByTestId("phrase-submit"));
    });
    expect(getByTestId("phrase-purpose")).toBeTruthy();
    expect(getByText(/doesn't control/)).toBeTruthy();
  });

  it("shows progress while enabling and a retry on probe failure", () => {
    mockAccess = { state: "needs_enable", isEnabling: true };
    const progress = render(<SignerGate><Child /></SignerGate>);
    expect(progress.getByTestId("enable-messages-progress")).toBeTruthy();
    progress.unmount();

    mockAccess = { state: "error" };
    const failed = render(<SignerGate><Child /></SignerGate>);
    fireEvent.press(failed.getByTestId("messages-access-retry"));
    expect(mockRefresh).toHaveBeenCalled();
  });

  it("shows the feature-off state regardless of access", () => {
    useMessageStore.getState().setAvailability("unavailable");
    const { getByTestId } = render(<SignerGate><Child /></SignerGate>);
    expect(getByTestId("messages-unavailable")).toBeTruthy();
  });
});
