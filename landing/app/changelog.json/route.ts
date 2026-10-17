import { CHANGELOG_ENTRIES, CHANGELOG_VERSION } from "@/lib/changelog";

// Partner integration manifests (zaoos.com/api/juke/status and similar)
// fetch this cross-origin to diff their open-asks lists against shipped
// items. Open CORS is intentional — the payload is the same content
// served at juke.audio/llms.txt, just structured for programmatic
// consumption rather than prose parsing.
export async function GET() {
  const body = {
    version: CHANGELOG_VERSION,
    generated_at: new Date().toISOString(),
    canonical_spec: "https://juke.audio/llms.txt",
    skill_md: "https://juke.audio/SKILL.md",
    entries: CHANGELOG_ENTRIES,
  };
  return Response.json(body, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Cache-Control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
      "X-Juke-Changelog": `v${CHANGELOG_VERSION}`,
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}
