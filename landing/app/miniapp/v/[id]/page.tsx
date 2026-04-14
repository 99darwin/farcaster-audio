import { notFound } from "next/navigation";
import { getVoiceNote } from "@/lib/voice-notes";
import { MiniAppPlayer } from "./mini-app-player";

type PageProps = { params: Promise<{ id: string }> };

export default async function MiniAppVoiceNotePage({ params }: PageProps) {
  const { id } = await params;
  const data = await getVoiceNote(id);
  if (!data) notFound();

  return <MiniAppPlayer data={data} />;
}
