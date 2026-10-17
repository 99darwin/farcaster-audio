import {
  RECOVERY_PHRASE_MASK_CLASS,
  getRecoveryPhraseFieldAttributes,
  supportsTextMasking,
} from "@/lib/auth/recoveryPhraseField";

describe("getRecoveryPhraseFieldAttributes", () => {
  it.each([false, true])(
    "is never a credential field browsers offer to save (revealed=%s)",
    (isRevealed) => {
      const attributes = getRecoveryPhraseFieldAttributes(isRevealed);
      expect(attributes.type).toBe("text");
      expect(attributes).not.toHaveProperty("name");
    },
  );

  it("masks with -webkit-text-security while hidden", () => {
    expect(getRecoveryPhraseFieldAttributes(false).className).toBe(
      RECOVERY_PHRASE_MASK_CLASS,
    );
    expect(RECOVERY_PHRASE_MASK_CLASS).toContain("-webkit-text-security:disc");
  });

  it("drops the mask only while revealed", () => {
    expect(getRecoveryPhraseFieldAttributes(true).className).toBe("");
  });

  it.each([false, true])(
    "opts out of autofill, correction, spellcheck and password managers (revealed=%s)",
    (isRevealed) => {
      expect(getRecoveryPhraseFieldAttributes(isRevealed)).toMatchObject({
        autoComplete: "off",
        autoCorrect: "off",
        autoCapitalize: "none",
        spellCheck: false,
        "data-1p-ignore": "true",
        "data-lpignore": "true",
        "data-bwignore": "true",
      });
    },
  );

  it("never carries a value attribute — the field stays uncontrolled", () => {
    expect(getRecoveryPhraseFieldAttributes(false)).not.toHaveProperty("value");
    expect(getRecoveryPhraseFieldAttributes(true)).not.toHaveProperty(
      "defaultValue",
    );
  });
});

describe("supportsTextMasking", () => {
  const originalCss = globalThis.CSS;

  afterEach(() => {
    Object.defineProperty(globalThis, "CSS", {
      value: originalCss,
      configurable: true,
      writable: true,
    });
  });

  function stubCss(value: unknown): void {
    Object.defineProperty(globalThis, "CSS", {
      value,
      configurable: true,
      writable: true,
    });
  }

  it("asks CSS.supports about -webkit-text-security", () => {
    const supports = jest.fn().mockReturnValue(true);
    stubCss({ supports });
    expect(supportsTextMasking()).toBe(true);
    expect(supports).toHaveBeenCalledWith("-webkit-text-security", "disc");
  });

  it("reports false when unsupported or CSS is unavailable", () => {
    stubCss({ supports: () => false });
    expect(supportsTextMasking()).toBe(false);
    stubCss(undefined);
    expect(supportsTextMasking()).toBe(false);
  });
});
