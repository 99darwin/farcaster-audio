import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  requestConfirmation,
  useConfirmationStore,
  type ConfirmationRequest,
} from "@/stores/confirmationStore";

const REQUEST: ConfirmationRequest = {
  title: "Leave Juke?",
  message: "Example wants to open a link.",
  confirmLabel: "Open link",
  detail: "https://example.com",
};

describe("confirmationStore", () => {
  beforeEach(() => {
    useConfirmationStore.getState().resolveConfirmation(false);
  });

  it("resolves true only after an explicit confirm", async () => {
    const pending = requestConfirmation(REQUEST);
    expect(useConfirmationStore.getState().pending?.request).toEqual(REQUEST);
    useConfirmationStore.getState().resolveConfirmation(true);
    await expect(pending).resolves.toBe(true);
    expect(useConfirmationStore.getState().pending).toBeNull();
  });

  it("resolves false on cancel", async () => {
    const pending = requestConfirmation(REQUEST);
    useConfirmationStore.getState().resolveConfirmation(false);
    await expect(pending).resolves.toBe(false);
  });

  it("refuses a second request instead of replacing the visible one", async () => {
    const first = requestConfirmation(REQUEST);
    const second = requestConfirmation({ ...REQUEST, detail: "https://evil.example" });
    await expect(second).resolves.toBe(false);
    expect(useConfirmationStore.getState().pending?.request.detail).toBe(
      "https://example.com",
    );
    useConfirmationStore.getState().resolveConfirmation(true);
    await expect(first).resolves.toBe(true);
  });

  it("ignores a resolve with nothing pending", () => {
    expect(() =>
      useConfirmationStore.getState().resolveConfirmation(true),
    ).not.toThrow();
  });
});
