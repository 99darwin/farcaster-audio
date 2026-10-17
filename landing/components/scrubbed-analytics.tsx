"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { scrubAnalyticsUrl } from "@/lib/embed-partner-token";

function handleBeforeSend(event: BeforeSendEvent): BeforeSendEvent | null {
  const url = scrubAnalyticsUrl(event.url);
  return url ? { ...event, url } : null;
}

/**
 * Vercel Analytics with credential-bearing URL parts (partner `?token=`,
 * fragments) removed from every event. A client component because
 * `beforeSend` is a function and can't cross the server/client boundary.
 */
export function ScrubbedAnalytics() {
  return <Analytics beforeSend={handleBeforeSend} />;
}
