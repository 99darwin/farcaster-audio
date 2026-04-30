import {
  Pressable,
  Text,
  View,
  ActivityIndicator,
  Linking,
} from "react-native";
import { useRouter } from "expo-router";
import type { ButtonProps, SnapEvents } from "@/types/snap";
import { useSnapContext } from "../context";
import { useComposeStore } from "@/stores/composeStore";
import { resolvePaletteColor } from "@/constants/snapPalette";
import { useThemedStyles } from "@/hooks/useThemedStyles";

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

      case "open_url": {
        const target = params?.target as string | undefined;
        if (target) Linking.openURL(target).catch(() => {});
        break;
      }

      case "open_snap": {
        // TODO: render inline snap — for now open externally
        const target = params?.target as string | undefined;
        if (target) Linking.openURL(target).catch(() => {});
        break;
      }

      case "view_cast": {
        const hash = params?.hash as string | undefined;
        if (hash) router.push(`/cast/${hash}`);
        break;
      }

      case "view_profile": {
        const fid = params?.fid as number | undefined;
        if (fid) router.push(`/profile/${fid}`);
        break;
      }

      case "compose_cast": {
        useComposeStore.getState().requestCompose({
          text: (params?.text as string) ?? undefined,
          embeds: (params?.embeds as string[]) ?? undefined,
        });
        break;
      }

      case "open_mini_app": {
        const target = params?.target as string | undefined;
        if (target) Linking.openURL(target).catch(() => {});
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
