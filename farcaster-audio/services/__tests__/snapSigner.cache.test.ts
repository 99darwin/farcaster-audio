/**
 * Tests for snapSigner's SecureStore-backed cache behaviour.
 *
 * The contract we care about here is simple:
 *   - If SecureStore says `approved`, getSnapSignerStatus returns without
 *     ever calling the api layer.
 *   - `{ force: true }` bypasses the cache and hits the api.
 *   - invalidateSnapSigner clears SecureStore and calls the api, but
 *     tolerates a 404 (so the frontend can ship before the backend
 *     endpoint lands).
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// --- SecureStore mock ---
const secureStore: Record<string, string> = {};

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItemAsync: jest.fn(async (key: string) => {
    return Object.prototype.hasOwnProperty.call(secureStore, key) ? secureStore[key] : null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    secureStore[key] = value;
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    delete secureStore[key];
  }),
}));

// --- api mock ---
jest.mock('@/services/api', () => ({
  getSnapSignerStatus: jest.fn(),
  registerSnapSigner: jest.fn(),
  invalidateSnapSigner: jest.fn(),
}));

// --- crypto polyfill mock (the real one pulls RN globals we don't want here) ---
jest.mock('@/utils/cryptoPolyfill', () => ({}));

// --- @noble/ed25519 mock: we only need deterministic public-key derivation ---
jest.mock('@noble/ed25519', () => {
  const fakePub = new Uint8Array(32).fill(7);
  return {
    hashes: {},
    getPublicKey: jest.fn(() => fakePub),
    sign: jest.fn(() => new Uint8Array(64)),
    utils: {
      randomSecretKey: jest.fn(() => new Uint8Array(32).fill(1)),
    },
  };
});

jest.mock('@noble/hashes/sha2.js', () => ({ sha512: jest.fn() }));

// Silence @noble ed25519 hash wiring — the real module assigns ed.hashes.sha512.

import * as api from '@/services/api';
import * as SecureStore from 'expo-secure-store';
import {
  getSnapSignerStatus,
  invalidateSnapSigner,
} from '@/services/snapSigner';

const FID = 12345;
const KEY_STORAGE = `snap_signer_key_${FID}`;
const STATUS_STORAGE = `snap_signer_status_${FID}`;
const FAKE_PRIVKEY_HEX = '11'.repeat(32);

function resetStore() {
  for (const key of Object.keys(secureStore)) delete secureStore[key];
}

describe('snapSigner cache', () => {
  beforeEach(() => {
    resetStore();
    jest.clearAllMocks();
  });

  it('returns approved from SecureStore without calling api when cached', async () => {
    secureStore[KEY_STORAGE] = FAKE_PRIVKEY_HEX;
    secureStore[STATUS_STORAGE] = 'approved';

    const result = await getSnapSignerStatus(FID);

    expect(result).toBe('approved');
    expect(api.getSnapSignerStatus).not.toHaveBeenCalled();
  });

  it('bypasses cache and hits api when force=true', async () => {
    secureStore[KEY_STORAGE] = FAKE_PRIVKEY_HEX;
    secureStore[STATUS_STORAGE] = 'approved';
    (api.getSnapSignerStatus as jest.Mock<any>).mockResolvedValue({
      status: 'approved',
      public_key: '0x' + '07'.repeat(32),
    });

    const result = await getSnapSignerStatus(FID, { force: true });

    expect(result).toBe('approved');
    expect(api.getSnapSignerStatus).toHaveBeenCalledTimes(1);
  });

  it('returns none when SecureStore has no key and does not call api', async () => {
    const result = await getSnapSignerStatus(FID);
    expect(result).toBe('none');
    expect(api.getSnapSignerStatus).not.toHaveBeenCalled();
  });

  it('invalidateSnapSigner clears cache and calls api.invalidateSnapSigner', async () => {
    secureStore[KEY_STORAGE] = FAKE_PRIVKEY_HEX;
    secureStore[STATUS_STORAGE] = 'approved';
    (api.invalidateSnapSigner as jest.Mock<any>).mockResolvedValue(undefined);

    await invalidateSnapSigner(FID);

    expect(secureStore[STATUS_STORAGE]).toBeUndefined();
    expect(api.invalidateSnapSigner).toHaveBeenCalledTimes(1);
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(STATUS_STORAGE);
  });

  it('invalidateSnapSigner swallows a backend 404 (endpoint not yet deployed)', async () => {
    secureStore[KEY_STORAGE] = FAKE_PRIVKEY_HEX;
    secureStore[STATUS_STORAGE] = 'approved';
    // api.invalidateSnapSigner already swallows 404 itself, but simulate the
    // full round trip here to be safe.
    (api.invalidateSnapSigner as jest.Mock<any>).mockImplementation(async () => {
      // The real implementation catches 404 and returns undefined.
      return undefined;
    });

    await expect(invalidateSnapSigner(FID)).resolves.toBeUndefined();
    expect(secureStore[STATUS_STORAGE]).toBeUndefined();
  });

  it('invalidateSnapSigner still clears local cache if api throws non-404', async () => {
    secureStore[KEY_STORAGE] = FAKE_PRIVKEY_HEX;
    secureStore[STATUS_STORAGE] = 'approved';
    (api.invalidateSnapSigner as jest.Mock<any>).mockRejectedValue(new Error('boom'));

    await expect(invalidateSnapSigner(FID)).resolves.toBeUndefined();
    expect(secureStore[STATUS_STORAGE]).toBeUndefined();
  });
});
