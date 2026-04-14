export const Config = {
  API_BASE_URL: "https://your-api-host.example.com",

  SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN ?? "",

  LIVEKIT_WS_URL: __DEV__
    ? "wss://your-livekit-host.livekit.cloud"
    : "wss://your-livekit-host.livekit.cloud",

  RECORDING_ENABLED: false,
  MAX_SPEAKERS: 10,
  MAX_LISTENERS: 500,
  RECONNECT_MAX_ATTEMPTS: 5,
  RECONNECT_BASE_DELAY_MS: 1000,
  TOKEN_REFRESH_BUFFER_SEC: 300,

  WEB_BASE_URL: "https://juke.audio",
  TESTFLIGHT_URL: "https://testflight.apple.com/join/YOUR_TESTFLIGHT_CODE",
} as const;
