import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { Linking } from "react-native";
import {
  confirmAndOpenExternalUrl,
  openSafeExternalUrl,
} from "@/utils/externalLinks";
import { useConfirmationStore } from "@/stores/confirmationStore";

const openURL = jest.spyOn(Linking, "openURL");

const UNSAFE_URLS: unknown[] = [
  "javascript:alert(1)",
  "tel:+15555550100",
  "sms:+15555550100",
  "file:///etc/passwd",
  "http://example.com",
  "https://127.0.0.1/admin",
  "https://localhost/",
  "otherapp://pay?amount=1",
  "",
  null,
  42,
];

describe("openSafeExternalUrl", () => {
  beforeEach(() => {
    openURL.mockReset();
    openURL.mockResolvedValue(true);
  });

  it("opens a public https URL", async () => {
    await expect(openSafeExternalUrl("https://example.com/a")).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledWith("https://example.com/a");
  });

  it.each(UNSAFE_URLS)("never opens %p", async (url) => {
    await expect(openSafeExternalUrl(url)).resolves.toBe(false);
    expect(openURL).not.toHaveBeenCalled();
  });

  it("reports false when the OS refuses", async () => {
    openURL.mockRejectedValue(new Error("no handler"));
    await expect(openSafeExternalUrl("https://example.com")).resolves.toBe(false);
  });
});

describe("confirmAndOpenExternalUrl", () => {
  beforeEach(() => {
    openURL.mockReset();
    openURL.mockResolvedValue(true);
    useConfirmationStore.getState().resolveConfirmation(false);
  });

  it("shows the exact URL and opens only after confirm", async () => {
    const result = confirmAndOpenExternalUrl("https://example.com/x", {
      sourceName: "Cool App",
    });
    const pending = useConfirmationStore.getState().pending;
    expect(pending?.request.detail).toBe("https://example.com/x");
    expect(pending?.request.message).toContain("Cool App");
    expect(openURL).not.toHaveBeenCalled();
    useConfirmationStore.getState().resolveConfirmation(true);
    await expect(result).resolves.toBe(true);
    expect(openURL).toHaveBeenCalledWith("https://example.com/x");
  });

  it("does not open when declined", async () => {
    const result = confirmAndOpenExternalUrl("https://example.com", {
      sourceName: "Cool App",
    });
    useConfirmationStore.getState().resolveConfirmation(false);
    await expect(result).resolves.toBe(false);
    expect(openURL).not.toHaveBeenCalled();
  });

  it("drops unsafe URLs without prompting", async () => {
    await expect(
      confirmAndOpenExternalUrl("tel:+15555550100", { sourceName: "x" }),
    ).resolves.toBe(false);
    expect(useConfirmationStore.getState().pending).toBeNull();
  });
});
