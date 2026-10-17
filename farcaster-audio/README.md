# farcaster-audio

Expo (bare workflow) iOS + Android client for Juke / Farcaster Audio Spaces.

## Android distribution

The app ships on Android in two parallel channels:

- **Firebase App Distribution** (current) — interim distribution while Play Console payment profile / Dun & Bradstreet verification is pending. Public install link is configured on the landing site at `juke.audio`.
- **Play Console internal track** (after D&B clears) — `eas.json`'s `production.android` profile is already wired for this. See "Play Store submission" below.

## Android push notifications (FCM)

Android push delivery goes through Firebase Cloud Messaging. Expo wraps FCM so the same `ExponentPushToken[...]` flow works on both platforms — but the project still needs FCM credentials.

### One-time setup

1. Create a Firebase project at https://console.firebase.google.com.
2. Add an Android app with package name `xyz.juke.app`.
3. Download the generated `google-services.json` and place it at `farcaster-audio/google-services.json`. The file is gitignored — do not commit it.
4. Upload it to EAS as a file environment variable so cloud builds can find it:
   ```bash
   eas env:create \
     --name GOOGLE_SERVICES_JSON \
     --type file \
     --value ./google-services.json \
     --environment preview \
     --visibility secret

   eas env:create \
     --name GOOGLE_SERVICES_JSON \
     --type file \
     --value ./google-services.json \
     --environment production \
     --visibility secret
   ```
5. `app.config.js` dynamically resolves `android.googleServicesFile` from `process.env.GOOGLE_SERVICES_JSON` at build time, falling back to the local `./google-services.json` for local dev. No further config needed.
6. For local Android builds, run `npx expo prebuild --platform android --clean` — the prebuild step copies `google-services.json` into the generated `android/` directory automatically.

After setup, the existing `usePushNotifications` hook will request permission, fetch an Expo push token, and register it with the backend on both iOS and Android.

## Play Store submission

The Android internal beta currently ships via Firebase App Distribution. Once D&B verification clears and the Play Console payment profile is finalized:

### 1. Create the Play Console app

- Package name: `xyz.juke.app` (matches `app.json`)
- First-time setup: complete the app content forms (privacy policy URL, target audience, data safety, content rating questionnaire). Play Console blocks production releases until these are filled, but **internal track works without them for the very first build**.

### 2. Create a service account for `eas submit`

- Play Console → Setup → API access → Create new service account (links you to Google Cloud Console)
- In Cloud Console: create service account, grant role "Service Account User", generate a JSON key
- Back in Play Console: grant the service account the "Release manager" role on the Juke app
- Download the JSON key as `farcaster-audio/play-service-account.json` (gitignored)
- For EAS-only environments, upload as an EAS file env var so cloud submits work:
  ```bash
  eas env:create \
    --name GOOGLE_SERVICE_ACCOUNT_KEY \
    --type file \
    --value ./play-service-account.json \
    --environment production \
    --visibility secret
  ```
  Then update `eas.json` `submit.production.android.serviceAccountKeyPath` from `./play-service-account.json` to `$GOOGLE_SERVICE_ACCOUNT_KEY`.

### 3. First build + manual upload (Play Console requirement)

The very first AAB has to be uploaded by hand to bind the app to the package name. EAS Submit can't do this; subsequent submits can.

```bash
eas build -p android --profile production
# Download the AAB artifact from the EAS dashboard
# In Play Console: Internal testing → Create new release → upload AAB
```

### 4. Subsequent releases via EAS Submit

```bash
eas build -p android --profile production
eas submit -p android --profile production
```

This pushes the latest AAB to the Internal track as a draft release (per `eas.json` config). Promote to live testers in the Play Console UI.

### 5. Promote tracks when ready

Internal testing → Closed testing → Open testing → Production, via the Play Console release dashboard. Each promotion is a one-click action; the AAB is the same.

### Common first-submission gotchas

- **"Upload key" vs "App signing key"** — let Play Console manage app signing (Play App Signing is the default and what EAS expects). EAS manages the upload key.
- **Content rating questionnaire** must be filled before promoting beyond the initial internal release.
- **Target SDK** — Play Console enforces a minimum target SDK each year. Expo SDK 55 / RN 0.83 targets SDK 34, which meets the 2026 requirement.
- **`versionCode`** must be higher than any previously uploaded. `eas.json`'s `production.android.autoIncrement: true` handles this automatically.
- **Branding & screenshots** — Play Console requires screenshots, feature graphic, short/long description before promoting beyond internal. Internal track does not need them.
