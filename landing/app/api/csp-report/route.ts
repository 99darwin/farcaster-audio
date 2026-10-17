import { NextResponse, type NextRequest } from "next/server";
import {
  MAX_CSP_REPORT_BYTES,
  parseCspReports,
} from "@/lib/security/cspReport";

/**
 * CSP violation collector named by the policy's `report-uri` / `report-to`
 * (`lib/security/csp.ts`). Logs one redacted line per violation so a vendor
 * host moving (storage, LiveKit, video CDN) shows up in the deployment logs
 * instead of failing silently in users' browsers. Answers 204 for any
 * well-formed JSON; there is nothing for the browser to act on.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_CSP_REPORT_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  // Re-checked after reading: content-length is optional (chunked bodies).
  const raw = await request.text();
  if (raw.length > MAX_CSP_REPORT_BYTES) {
    return new NextResponse(null, { status: 413 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  for (const violation of parseCspReports(payload)) {
    console.warn("[csp-report]", JSON.stringify(violation));
  }
  return new NextResponse(null, { status: 204 });
}
