export const Config = {
  API_BASE_URL:
    process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:8000",

  /**
   * Public Hypersnap node for unauthenticated reads (FID lookup on the
   * sign-in screen). Not a secret; overridable per build.
   */
  HYPERSNAP_HTTP_URL:
    process.env.EXPO_PUBLIC_HYPERSNAP_HTTP_URL ?? "https://haatz.quilibrium.com",

  SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN ?? "",

  LIVEKIT_WS_URL: process.env.EXPO_PUBLIC_LIVEKIT_WS_URL ?? "",

  RECORDING_ENABLED: false,
  MAX_SPEAKERS: 10,
  MAX_LISTENERS: 500,
  RECONNECT_MAX_ATTEMPTS: 5,
  RECONNECT_BASE_DELAY_MS: 1000,
  TOKEN_REFRESH_BUFFER_SEC: 300,

  WEB_BASE_URL: process.env.EXPO_PUBLIC_WEB_BASE_URL ?? "http://localhost:3000",
} as const;
