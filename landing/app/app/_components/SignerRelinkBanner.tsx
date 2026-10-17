"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth/AuthProvider";
import { RELINK_PATH } from "@/lib/auth/signerStatus";

const LOGIN_PATH = "/app/login";

/**
 * Shown while the signed-in account is read-only because its app signer
 * isn't approved (auth contract section 3). Hidden on the sign-in screen,
 * which is where it links to.
 */
export function SignerRelinkBanner() {
  const { isReadOnly } = useAuth();
  const pathname = usePathname();

  if (!isReadOnly || pathname === LOGIN_PATH) return null;

  return (
    <div
      role="status"
      className="border-b border-juke-orange/30 bg-juke-orange/10 px-4 py-2 text-center text-sm text-juke-text-on-dark"
    >
      Juke can&apos;t post for your account right now, so you&apos;re in
      read-only mode.{" "}
      <Link
        href={RELINK_PATH}
        className="font-semibold text-juke-orange underline-offset-2 hover:underline"
      >
        Re-link this browser
      </Link>
    </div>
  );
}
