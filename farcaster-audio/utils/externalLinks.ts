import { Linking } from "react-native";
import { requestConfirmation } from "@/stores/confirmationStore";
import { isValidMiniAppUrl } from "@/utils/url";

/**
 * Open a URL that came from untrusted content (snaps, OG embeds, search
 * results) only if it is a public https URL. Custom schemes (`tel:`,
 * `sms:`, other apps' deep links), `javascript:`, `file:` and private
 * hosts are dropped. Returns whether the OS was asked to open it.
 */
export async function openSafeExternalUrl(url: unknown): Promise<boolean> {
  if (typeof url !== "string" || !isValidMiniAppUrl(url)) return false;
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Same validation as `openSafeExternalUrl`, plus a confirmation sheet
 * showing the exact URL. Used where the request is programmatic (a mini
 * app calling `openUrl`, an off-domain WebView navigation) rather than a
 * tap the user made on Juke's own UI.
 */
export async function confirmAndOpenExternalUrl(
  url: unknown,
  { sourceName }: { sourceName: string },
): Promise<boolean> {
  if (typeof url !== "string" || !isValidMiniAppUrl(url)) return false;
  const isConfirmed = await requestConfirmation({
    title: "Leave Juke?",
    message: `${sourceName} wants to open this link in your browser.`,
    detail: url,
    confirmLabel: "Open link",
  });
  if (!isConfirmed) return false;
  return openSafeExternalUrl(url);
}
