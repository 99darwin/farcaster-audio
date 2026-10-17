/**
 * Constants for Farcaster-native integration (client.farcaster.xyz bearer,
 * Mini App sync entry).
 *
 * There is deliberately no deep-link return path for the bearer: the old
 * `juke://sync-complete#bearer=...` handler let any web page plant a bearer
 * (see `services/farcasterBearer.ts`). A future return path must be bound
 * to a single-use `state` and to the signed-in fid before it stores anything.
 */

/** Public URL that opens the Juke "sync" Mini App inside Warpcast. */
export const MINIAPP_SYNC_URL =
  "https://farcaster.xyz/miniapps/juke/sync?return_to=app";

/**
 * Default "expiring soon" window in hours. Bearers typically last ~7 days;
 * we surface a re-sync prompt 24h before expiry so the user can refresh
 * before any native call would fail.
 */
export const BEARER_EXPIRING_SOON_HOURS = 24;
