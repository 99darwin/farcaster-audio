# Security Policy

## Reporting a vulnerability

If you believe you've found a security vulnerability in Juke, please report it privately.

**Email:** `nicksapsales@gmail.com`

Include in your report:

- A description of the vulnerability and its potential impact
- Steps to reproduce (or a proof of concept)
- The affected app(s): backend, mobile, or landing
- Your name/handle for credit (optional)

Please do **not** open a public GitHub issue for security reports.

## Disclosure window

We aim to:

- Acknowledge your report within **3 business days**
- Provide an initial assessment within **7 days**
- Ship a fix or mitigation within **90 days** of acknowledgment

After a fix ships, you're welcome to publish a write-up. We'll credit you in the release notes if you'd like.

## In scope

- The backend API (`backend/`) — authentication, authorization, data exposure, injection, SSRF, etc.
- The mobile app's auth flow (`farcaster-audio/`) — SIWN, JWT handling, secure storage, deep link handling
- Landing-side miniapp webhooks and Farcaster auth surfaces (`landing/`)
- Any cryptographic implementation in this repo

## Out of scope

Vulnerabilities in third-party services we integrate with should be reported to those vendors directly:

- **Neynar** — Farcaster API: https://neynar.com/
- **LiveKit** — Audio SFU: https://livekit.io/
- **Cloudinary**, **Giphy**, **Deepgram**, **AWS**, **Sentry** — report via each vendor's published security contact

Also out of scope:

- Issues requiring physical access to an unlocked device
- Self-XSS or social engineering of repo maintainers
- Findings against forks running their own credentials (file with the fork operator)
- Volumetric DoS without a novel amplification vector

## PGP key

Available on request.
