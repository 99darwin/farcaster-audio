import type { SignerStatus, UserResponse } from "@/lib/api/types";
import {
  RELINK_PATH,
  isRelinkRequest,
  isSignerReadOnly,
} from "@/lib/auth/signerStatus";
import { LOGIN_RESPONSE } from "./fixtures";

function userWith(signerStatus: SignerStatus | undefined): UserResponse {
  const { signer_status: _ignored, ...rest } = LOGIN_RESPONSE.user;
  return signerStatus === undefined
    ? rest
    : { ...rest, signer_status: signerStatus };
}

describe("isSignerReadOnly", () => {
  it("is false for an approved signer", () => {
    expect(isSignerReadOnly(userWith("approved"))).toBe(false);
  });

  it.each<SignerStatus>(["none", "pending", "revoked"])(
    "is true for signer_status %s",
    (status) => {
      expect(isSignerReadOnly(userWith(status))).toBe(true);
    },
  );

  it("treats an absent signer_status as unknown, not read-only", () => {
    expect(isSignerReadOnly(userWith(undefined))).toBe(false);
  });

  it("is false when signed out", () => {
    expect(isSignerReadOnly(null)).toBe(false);
  });
});

describe("isRelinkRequest", () => {
  it("recognises the re-link path's query", () => {
    const query = RELINK_PATH.slice(RELINK_PATH.indexOf("?"));
    expect(isRelinkRequest(new URLSearchParams(query))).toBe(true);
  });

  it.each(["", "?relink=0", "?relink=true", "?other=1"])(
    "is false for %p",
    (query) => {
      expect(isRelinkRequest(new URLSearchParams(query))).toBe(false);
    },
  );
});
