import type { Metadata } from "next";
import { EmbedSignInWindow } from "./embed-sign-in-window";

export const metadata: Metadata = {
  title: "Sign in to Juke",
  robots: { index: false, follow: false },
};

/**
 * First-party sign-in window opened by the hosted embed (see
 * `lib/embed-sign-in-popup.ts`). Lives outside `/embed/*` so it gets the
 * default `frame-ancestors`, not the embed's permissive one.
 */
export default function EmbedSignInPage() {
  return <EmbedSignInWindow />;
}
