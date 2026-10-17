/**
 * DOM attributes for the one-time recovery-phrase field (contract section 5).
 *
 * The field is deliberately NOT a credential field: it is a plain
 * `type="text"` input with no `name`, outside any `<form>`. Built-in password
 * managers (Chrome/Edge, Safari/iCloud Keychain, Firefox) key their "Save
 * password?" prompt off a `type="password"` field whose form is submitted or
 * disappears — exactly what happens after a successful link — and ignore
 * `autocomplete="off"` there. A saved phrase would be cloud-synced custody.
 *
 * Masking uses `-webkit-text-security: disc` (Chromium and Safari; support in
 * other engines varies). Where it is unsupported the field shows the phrase
 * and the UI says so ({@link supportsTextMasking}); "Show" removes the mask.
 *
 * Autofill, correction, spellcheck (which can send text to a cloud service)
 * and third-party password managers are all opted out.
 */

const TEXT_SECURITY_PROPERTY = "-webkit-text-security";
const TEXT_SECURITY_MASK = "disc";

/** Tailwind arbitrary property applying the mask while hidden. */
export const RECOVERY_PHRASE_MASK_CLASS = "[-webkit-text-security:disc]";

export interface RecoveryPhraseFieldAttributes {
  readonly type: "text";
  readonly autoComplete: "off";
  readonly autoCorrect: "off";
  readonly autoCapitalize: "none";
  readonly spellCheck: false;
  readonly "data-1p-ignore": "true";
  readonly "data-lpignore": "true";
  readonly "data-bwignore": "true";
  readonly "data-form-type": "other";
  readonly className: string;
}

export function getRecoveryPhraseFieldAttributes(
  isRevealed: boolean,
): RecoveryPhraseFieldAttributes {
  return {
    type: "text",
    autoComplete: "off",
    autoCorrect: "off",
    autoCapitalize: "none",
    spellCheck: false,
    "data-1p-ignore": "true",
    "data-lpignore": "true",
    "data-bwignore": "true",
    "data-form-type": "other",
    className: isRevealed ? "" : RECOVERY_PHRASE_MASK_CLASS,
  };
}

/** True when this browser can mask a text input via `-webkit-text-security`. */
export function supportsTextMasking(): boolean {
  if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
    return false;
  }
  return CSS.supports(TEXT_SECURITY_PROPERTY, TEXT_SECURITY_MASK);
}
