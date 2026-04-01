/**
 * Polyfill crypto.getRandomValues for React Native.
 * Must be imported before any module that uses Web Crypto (e.g. viem).
 *
 * react-native-get-random-values patches globalThis.crypto automatically on import.
 */
import 'react-native-get-random-values';
