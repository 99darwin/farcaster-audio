import sdk from "@farcaster/miniapp-sdk";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "https://your-api-host.example.com";

export interface MiniappAuthResult {
  token: string;
  fid: number;
}

/**
 * SIWF authentication flow for Farcaster miniapps.
 *
 * Flow:
 *   1. Fetch a server-generated nonce (one-time use, prevents replay).
 *   2. Prompt user via `sdk.actions.signIn` (Sign-In With Farcaster).
 *   3. POST signature + nonce to backend, receive JWT + FID.
 *
 * Returns null on any failure (user rejection, network error, verification failure).
 */
export async function authenticateMiniapp(): Promise<MiniappAuthResult | null> {
  try {
    const nonceResp = await fetch(`${API_BASE_URL}/v1/auth/miniapp-nonce`);
    if (!nonceResp.ok) return null;
    const { nonce } = await nonceResp.json();

    const result = await sdk.actions.signIn({ nonce });

    const resp = await fetch(`${API_BASE_URL}/v1/auth/miniapp-verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: result.message,
        signature: result.signature,
        nonce,
      }),
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    return { token: body.token, fid: body.fid };
  } catch {
    return null;
  }
}
