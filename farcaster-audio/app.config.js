// Dynamic Expo config. We keep the bulk of the configuration in app.json
// for static tooling and just override the one field that needs to be
// resolved from an EAS file environment variable at build time:
// `android.googleServicesFile`.
//
// EAS Build uploads the file env var to a temp path on the builder and
// exposes that path as `process.env.GOOGLE_SERVICES_JSON`. Locally,
// `process.env.GOOGLE_SERVICES_JSON` is unset, so we fall back to the
// in-repo path (`./google-services.json`, gitignored — the developer drops
// their own copy there for local builds).
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    googleServicesFile:
      process.env.GOOGLE_SERVICES_JSON ?? config.android.googleServicesFile,
  },
});
