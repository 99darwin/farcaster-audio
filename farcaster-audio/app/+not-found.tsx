import { useEffect } from "react";
import { useRouter } from "expo-router";

// expo-router auto-navigates here for any URL that doesn't match a route.
// Deep links such as juke://miniapp?url= intentionally have no route — our
// _layout.tsx deep-link handler picks them up imperatively. Snap back so the
// underlying screen is foregrounded again instead of leaving the user on a
// dev "Unmatched route" screen.
export default function NotFound() {
  const router = useRouter();
  useEffect(() => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  }, [router]);
  return null;
}
