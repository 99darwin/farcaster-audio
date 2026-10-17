/**
 * UTF-8 byte length of `text`. Farcaster's cast-length limit is enforced in
 * bytes, not characters, so the composer counter and over-limit checks must
 * count the same unit the protocol does. Lone surrogates count as 3 bytes
 * (the U+FFFD replacement TextEncoder would emit).
 *
 * Hand-rolled instead of `TextEncoder` because Hermes does not ship
 * `TextEncoder` without a polyfill.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
