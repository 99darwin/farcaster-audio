import React from "react";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render } from "@testing-library/react-native";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import {
  CONFIRM_ARM_DELAY_MS,
  ConfirmSheet,
} from "@/components/common/ConfirmSheet";
import {
  requestConfirmation,
  useConfirmationStore,
} from "@/stores/confirmationStore";

describe("ConfirmSheet", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    useConfirmationStore.getState().resolveConfirmation(false);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("renders nothing when idle", () => {
    const screen = render(<ConfirmSheet />);
    expect(screen.queryByTestId("confirm-sheet")).toBeNull();
  });

  it("shows the request and resolves true on confirm", async () => {
    const screen = render(<ConfirmSheet />);
    let result: Promise<boolean> = Promise.resolve(false);
    act(() => {
      result = requestConfirmation({
        title: "Leave Juke?",
        message: "Cool App wants to open this link.",
        detail: "https://example.com/x",
        confirmLabel: "Open link",
      });
    });
    expect(screen.getByText("Leave Juke?")).toBeTruthy();
    expect(screen.getByTestId("confirm-sheet-detail").props.children).toBe(
      "https://example.com/x",
    );
    // Confirm is not armed yet: an immediate tap (tapjacking) does nothing.
    fireEvent.press(screen.getByText("Open link"));
    expect(useConfirmationStore.getState().pending).not.toBeNull();
    act(() => {
      jest.advanceTimersByTime(CONFIRM_ARM_DELAY_MS);
    });
    fireEvent.press(screen.getByText("Open link"));
    await expect(result).resolves.toBe(true);
    expect(screen.queryByTestId("confirm-sheet")).toBeNull();
  });

  it.each([
    ["the cancel button", "Not now"],
    ["the backdrop", "backdrop"],
  ])("resolves false via %s", async (_label, target) => {
    const screen = render(<ConfirmSheet />);
    let result: Promise<boolean> = Promise.resolve(true);
    act(() => {
      result = requestConfirmation({
        title: "Sign in with Farcaster?",
        message: "m",
        confirmLabel: "Sign in",
      });
    });
    fireEvent.press(
      target === "backdrop"
        ? screen.getByTestId("confirm-sheet-backdrop", {
            // Sibling sheet is accessibilityViewIsModal, so the backdrop is
            // hidden from a11y queries; sighted taps still reach it.
            includeHiddenElements: true,
          })
        : screen.getByText(target),
    );
    await expect(result).resolves.toBe(false);
  });
});
