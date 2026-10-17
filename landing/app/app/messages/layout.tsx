import { Suspense, type ReactNode } from "react";
import type { Metadata } from "next";
import { MessagesShell } from "@/components/messages/MessagesShell";

export const metadata: Metadata = {
  title: "Messages · Juke",
};

/**
 * `/app/messages/**` layout. Routes below read search params (`?m=`,
 * `?fid=`), so the shell sits under a Suspense boundary to keep the routes
 * statically renderable.
 */
export default function MessagesLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <MessagesShell>{children}</MessagesShell>
    </Suspense>
  );
}
