import { useEffect } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { Config } from "@/constants/config";

/**
 * Deep link landing route for juke://voice-note/{id}.
 * Fetches the voice note, then redirects to the cast thread or author profile.
 */
export default function VoiceNoteRedirect() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    if (!id) return;

    fetch(`${Config.API_BASE_URL}/v1/voice-notes/${id}`)
      .then((res) => res.json())
      .then((data) => {
        const castHash = data?.voice_note?.cast_hash;
        if (castHash) {
          router.replace(`/cast/${castHash}`);
        } else {
          const fid = data?.voice_note?.fid;
          if (fid) {
            router.replace(`/profile/${fid}`);
          } else {
            router.replace("/");
          }
        }
      })
      .catch(() => {
        router.replace("/");
      });
  }, [id, router]);

  return <LoadingSpinner fullScreen />;
}
