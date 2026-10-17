/**
 * Per-user record of the mini app domains the user has explicitly let sign
 * them in. A mini app's `signIn()` call produces a SIWF signature that logs
 * the page in as the user, so the first request from each domain needs a
 * deliberate tap; later requests from the same domain go straight through.
 */

import * as SecureStore from "expo-secure-store";

const CONSENT_KEY_PREFIX = "miniapp_signin_consent_";
/** Bound the stored list so a hostile sequence of domains can't grow it forever. */
const MAX_REMEMBERED_DOMAINS = 200;

function consentKey(fid: number): string {
  return `${CONSENT_KEY_PREFIX}${fid}`;
}

function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase();
}

async function readConsentedDomains(fid: number): Promise<string[]> {
  const raw = await SecureStore.getItemAsync(consentKey(fid));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((d): d is string => typeof d === "string")
      : [];
  } catch {
    return [];
  }
}

export async function hasSignInConsent(
  fid: number,
  domain: string,
): Promise<boolean> {
  const domains = await readConsentedDomains(fid);
  return domains.includes(normalizeDomain(domain));
}

export async function rememberSignInConsent(
  fid: number,
  domain: string,
): Promise<void> {
  const normalized = normalizeDomain(domain);
  const domains = await readConsentedDomains(fid);
  if (domains.includes(normalized)) return;
  const next = [...domains, normalized].slice(-MAX_REMEMBERED_DOMAINS);
  await SecureStore.setItemAsync(consentKey(fid), JSON.stringify(next));
}
