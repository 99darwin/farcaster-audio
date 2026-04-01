/**
 * Polyfill crypto.getRandomValues for React Native.
 * Must be imported before any module that uses Web Crypto (e.g. viem).
 */
import { getRandomValues } from 'expo-crypto';

if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = {} as Crypto;
}
if (!globalThis.crypto.getRandomValues) {
  globalThis.crypto.getRandomValues = getRandomValues as any;
}
