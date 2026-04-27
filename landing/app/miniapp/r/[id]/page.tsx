import { notFound } from "next/navigation";
import { getRecording } from "@/lib/recordings";
import { MiniAppRecordingPlayer } from "./mini-app-recording-player";

type PageProps = { params: Promise<{ id: string }> };

export default async function MiniAppRecordingPage({ params }: PageProps) {
  const { id } = await params;
  const data = await getRecording(id);
  if (!data) notFound();

  return <MiniAppRecordingPlayer data={data} />;
}
