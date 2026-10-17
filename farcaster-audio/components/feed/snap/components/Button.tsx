import {
  Pressable,
  Text,
  View,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import type { ButtonProps, SnapEvents } from "@/types/snap";
import { useSnapContext } from "../context";
import { useComposeStore } from "@/stores/composeStore";
import { resolvePaletteColor } from "@/constants/snapPalette";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { openSafeExternalUrl } from "@/utils/externalLinks";
import { isValidCastHash, parseFid } from "@/utils/farcasterIds";

interface Props {
  id: string;
  props: ButtonProps;
  on?: SnapEvents;
}

export function SnapButton({ id, props, on }: Props) {
  const { accent, submitButton, signerStatus, submitting } = useSnapContext();
  const router = useRouter();
  const styles = useStyles();
  const accentColor = resolvePaletteColor("accent", accent);
  const primary = props.variant !== "secondary";

  const action = on?.press?.action ?? "submit";
  const params = on?.press?.params as Record<string, unknown> | undefined;
  const isSubmit = action === "submit";
  const canInteract = !submitting;

  const handlePress = () => {
    if (!canInteract) return;

    switch (action) {
      case "submit":
        submitButton(id).catch(() => {});
        break;

      // TODO: render open_snap inline — for now open externally.
      case "open_url":
      case "open_snap":
      case "open_mini_app": {
        // Snap params are author-controlled: only public https URLs may
        // leave the app (no tel:/sms:/other-app schemes, no private hosts).
        void openSafeExternalUrl(params?.target);
        break;
      }

      case "view_cast": {
        const hash = params?.hash;
        if (isValidCastHash(hash)) router.push(`/cast/${hash}`);
        break;
      }

      case "view_profile": {
        const fid = parseFid(params?.fid);
        if (fid !== null) router.push(`/profile/${fid}`);
        break;
      }

      case "compose_cast": {
        useComposeStore.getState().requestCompose({
          text: (params?.text as string) ?? undefined,
          embeds: (params?.embeds as string[]) ?? undefined,
        });
        break;
      }

      default:
        // Unsupported actions (view_token, send_token, swap_token) — open
        // nothing rather than crash.
        break;
    }
  };

  const showEnableHint = isSubmit && signerStatus !== "approved";

  return (
    <Pressable
      disabled={!canInteract}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.button,
        primary
          ? { backgroundColor: accentColor }
          : {
              borderWidth: 1,
              borderColor: accentColor,
              backgroundColor: "transparent",
            },
        pressed && canInteract ? { opacity: 0.8 } : null,
      ]}
    >
      <View style={styles.row}>
        {submitting ? (
          <ActivityIndicator
            size="small"
            color={primary ? "#ffffff" : accentColor}
          />
        ) : null}
        <Text
          style={[styles.label, { color: primary ? "#ffffff" : accentColor }]}
          numberOfLines={1}
        >
          {props.label}
        </Text>
      </View>
      {showEnableHint ? (
        <Text style={styles.hint}>
          {signerStatus === "pending_approval"
            ? "Awaiting approval"
            : "Tap to enable"}
        </Text>
      ) : null}
    </Pressable>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    button: {
      borderRadius: 10,
      paddingVertical: 10,
      paddingHorizontal: 14,
      alignItems: "center" as const,
      justifyContent: "center" as const,
    },
    row: {
      flexDirection: "row" as const,
      alignItems: "center" as const,
      gap: 6,
    },
    label: {
      fontSize: 14,
      fontWeight: "600" as const,
    },
    hint: {
      marginTop: 2,
      fontSize: 10,
      color: colors.text.secondary,
    },
  }));
