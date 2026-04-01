# Miniapp Host: signIn() Implementation Status

## Current State (as of 2026-03-31)

Juke has a working miniapp host implementation with signIn() support:
- WebView host with RPC bridge (`@farcaster/miniapp-host-react-native` v0.1.19)
- Social actions: viewProfile, viewCast, composeCast, openMiniApp, addMiniApp
- **signIn() via auth address** — generates secp256k1 keypair on device, registers via Neynar, signs SIWF messages
- Haptics, splash screen, primary button, capability negotiation
- Full-screen modal with slide animation, minimized state with glass mini bar
- Cast embed detection (handles `fc_frame` + `frame` keys, intermediary URLs)
- Miniapp persistence via `expo-secure-store`

**What's needed to activate**: Users must register their auth address (one-time setup). Until approved, `signIn()` returns a graceful rejection. After approval, SIWF signing works fully.

## The Problem

Miniapp `signIn()` requires an **EIP-191 (secp256k1) signature** over a SIWF message. Our auth flow uses Neynar SIWN, which gives us:

| Credential | Type | Can sign SIWF? |
|------------|------|----------------|
| `signer_uuid` (Neynar managed) | Ed25519 | No — wrong curve |
| `custody_address` | secp256k1 address | No — we don't have the private key |

Quick Auth (`sdk.quickAuth.getToken()`) does NOT bypass this — it calls `signIn()` under the hood, sends the result to `auth.farcaster.xyz` for JWT issuance. The host still needs to produce the signature.

## signIn() Spec

```typescript
// Miniapp sends:
type SignInOptions = {
  nonce: string;                  // Random string, min 8 chars
  notBefore?: string;             // ISO 8601
  expirationTime?: string;        // ISO 8601
  acceptAuthAddress?: boolean;    // Default: true
};

// Host must return:
type SignInResult = {
  signature: string;              // EIP-191 signature hex
  message: string;                // SIWF message string (SIWE format)
  authMethod: 'custody' | 'authAddress';
};
```

The SIWF message is a SIWE (EIP-4361) message with:
- `statement`: `"Farcaster Auth"`
- `chainId`: `10` (Optimism)
- `resources`: includes `farcaster://fid/{fid}`
- `address`: custody address or auth address

## Solution: Auth Address Keypair

The recommended approach is generating a secp256k1 keypair on-device and registering it as an **auth address** for the user's FID.

### Implementation Steps

#### 1. Generate keypair (client-side)
- Generate secp256k1 private key using `viem`
- Store in `expo-secure-store` (keyed by FID)
- Derive the Ethereum address

#### 2. Register auth address (onchain)
- **This is the blocker** — registering requires authorization from the custody address
- The `KeyGateway.addFor()` contract on OP Mainnet accepts an EIP-712 signature from the FID owner
- Since we don't have the custody key, we need one of:
  - **Neynar API** for auth address registration (asked Rish — pending response)
  - **Warpcast deeplink** for one-time approval (similar to managed signer approval flow)
  - **Direct custody key access** (not viable — users auth via SIWN)

#### 3. Sign SIWF messages (client-side, after registration)
- Build SIWE message using `@farcaster/auth-client`'s `buildSignInMessage()`
- Sign with stored private key via `viem`'s `signMessage()`
- Return `{ signature, message, authMethod: 'authAddress' }`

### Key Contracts

| Contract | Address (OP Mainnet) | Purpose |
|----------|---------------------|---------|
| IdRegistry | `0x00000000Fc6c5F01Fc30151999387Bb99A9f489b` | FID ownership, custody/recovery addresses |
| KeyGateway | TBD | Adding keys (app keys + potentially auth addresses) |
| KeyRegistry | TBD | Key storage and lookup |

### Open Questions

1. **Does `KeyGateway` support auth address registration?** Current docs only show `keyType: 1` (Ed25519 app keys). Auth addresses are secp256k1 — is there a `keyType: 2`?

2. **Are auth addresses tracked onchain or on Hubs?** The SIWF verification uses a callback `isValidAuthAddress(address, fid)` rather than a direct contract read, suggesting they might be tracked differently than app keys.

3. **Can Neynar sponsor auth address registration?** They already sponsor managed signer (app key) registration. Same flow could work for auth addresses.

4. **Is there an alternative to onchain registration?** Some form of delegated auth that doesn't require an onchain tx.

## Dependencies

| Package | Purpose | Installed? |
|---------|---------|-----------|
| `viem` | secp256k1 key generation, EIP-191 signing | No (~400KB) |
| `@farcaster/auth-client` | SIWF message building + verification | No |
| `@farcaster/quick-auth` | Server-side JWT verification (for backend) | No |

## Packages Investigated (Not Helpful for Host)

- **`@farcaster/auth-kit`** — React web components for SIWF login buttons. Web-only, not usable in React Native.
- **`@farcaster/quick-auth`** — Server-side JWT verification library. Used by miniapp backends to verify Quick Auth tokens. Does NOT help the host produce signatures.
- **Neynar managed signers** — Ed25519 app keys for Farcaster protocol messages. Cannot produce EIP-191 signatures (different curve).
- **Neynar `lookupSigner` API** — Returns signer status and Ed25519 public key. No arbitrary message signing capability.

## Quick Auth Flow (for reference)

```
Miniapp calls sdk.quickAuth.getToken()
    |
    v
Miniapp SDK calls host's signIn({ nonce })  <-- HOST MUST SIGN
    |
    v
Host returns { signature, message, authMethod }
    |
    v
Miniapp SDK POSTs to https://auth.farcaster.xyz/verify-siwf
    |
    v
Server verifies signature, returns JWT { sub: fid, iss, aud, exp, iat }
    |
    v
Miniapp uses JWT as session token
```

## Files

| File | Role |
|------|------|
| `hooks/useMiniAppHost.ts` | Host implementation — signIn via auth address |
| `services/authAddress.ts` | Auth address key management + SIWF signing |
| `stores/miniappStore.ts` | Active miniapp state, added miniapps persistence |
| `components/miniapp/MiniAppModal.tsx` | WebView host UI |
| `services/manifest.ts` | Manifest fetching + resolution |
| `types/miniapp.ts` | Type re-exports from `@farcaster/miniapp-core` |
| `backend/app/services/auth_address_service.py` | EIP-712 signing + Neynar registration |
| `backend/app/routers/auth.py` | Auth address registration + status endpoints |

## Implementation (completed)

### Backend

**New env vars** (add to `.env`):
- `FARCASTER_APP_MNEMONIC` — mnemonic for Juke's Farcaster account (signs EIP-712 key requests)
- `FARCASTER_APP_FID` — Juke's registered Farcaster FID

**New dependency**: `eth-account>=0.13.0`

**New endpoints**:
- `POST /v1/auth/auth-address` — takes `{ auth_address }`, signs EIP-712 key request with app mnemonic, registers with Neynar (sponsored). Returns `{ auth_address, status, approval_url }`.
- `GET /v1/auth/auth-address/status?address=0x...` — checks registration status with Neynar.

**New service**: `backend/app/services/auth_address_service.py`

### Frontend

**New dependency**: `viem` (secp256k1 key generation + SIWF message signing)

**New service**: `farcaster-audio/services/authAddress.ts`
- `getOrCreateAuthAddress(fid)` — generates/retrieves keypair from `expo-secure-store`
- `registerAuthAddress(fid)` — calls backend to register with Neynar, returns approval URL
- `getAuthAddressStatus(fid)` — checks if approved (cached in secure store)
- `signSiwfMessage(fid, options)` — builds SIWE message + signs with stored key

**Updated**: `hooks/useMiniAppHost.ts`
- `signIn()` now checks auth address status and signs SIWF messages when approved
- `actions.signIn` added to `SUPPORTED_CAPABILITIES`

### User flow

1. User opens a miniapp that calls `signIn()` for the first time
2. If no auth address registered → graceful rejection (miniapp shows "sign in required")
3. User triggers auth address setup (TODO: UI for this — settings screen or prompt)
4. App generates secp256k1 keypair, stores private key in `expo-secure-store`
5. App calls `POST /v1/auth/auth-address` with the address
6. Backend signs EIP-712 request with app mnemonic, registers with Neynar (sponsored)
7. User opens `approval_url` (Warpcast deeplink) to approve the auth address onchain
8. Once approved, `signIn()` works — signs SIWF messages locally

### TODO

- [ ] UI for auth address registration (settings screen button or first-signIn prompt)
- [ ] Poll for approval status after user opens Warpcast deeplink
- [ ] Set `FARCASTER_APP_MNEMONIC` and `FARCASTER_APP_FID` in production env
- [ ] Register Juke's Farcaster account if not already done
- [ ] Test full flow end-to-end with a real miniapp

## Contact

Reached out to Rish (Farcaster/Neynar CEO) on 2026-03-31 asking about:
- Neynar API support for auth address registration
- Whether managed signer infrastructure can be extended for secp256k1 auth keys
- Any simpler path to producing SIWF signatures without custody key access
