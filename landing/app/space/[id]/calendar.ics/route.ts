import {
  buildSpaceCalendarEvent,
  getSpaceCalendarFilename,
  getSpaceDetail,
} from "@/lib/spaces";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const detail = await getSpaceDetail(id);
  const calendar = detail ? buildSpaceCalendarEvent(detail.room) : null;

  if (!calendar) {
    return new Response(
      "Calendar export is only available for upcoming scheduled spaces.",
      {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      },
    );
  }

  return new Response(calendar, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${getSpaceCalendarFilename(id)}"`,
      "Cache-Control": "public, max-age=30, stale-while-revalidate=300",
    },
  });
}
