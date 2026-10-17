import { Suspense } from "react";
import { LeaderboardPageClient } from "@/components/leaderboard/LeaderboardPageClient";
import { Spinner } from "@/components/ui/spinner";

/**
 * `useSearchParams` (used by `LeaderboardPageClient` to deep-link a cycle)
 * requires a Suspense boundary at the page level per Next.js App Router.
 */
export default function LeaderboardPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-juke-cream">
          <Spinner size="lg" />
        </div>
      }
    >
      <LeaderboardPageClient />
    </Suspense>
  );
}
