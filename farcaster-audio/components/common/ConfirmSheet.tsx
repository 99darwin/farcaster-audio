import { useEffect, useState } from "react";
import { Modal, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "@/components/common/Button";
import { radii, spacing, typography, withAlpha } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import { useConfirmationStore } from "@/stores/confirmationStore";

const DEFAULT_CANCEL_LABEL = "Not now";
/**
 * Confirm stays disabled this long after the sheet appears, so a page that
 * times a request to land under an expected tap (tapjacking) can't get a
 * confirm from a touch the user aimed at the content behind it.
 */
export const CONFIRM_ARM_DELAY_MS = 500;

/**
 * Root-mounted bottom sheet that renders whatever `requestConfirmation`
 * is waiting on. Backdrop tap and the Android back gesture both count as
 * "cancel"; only the confirm button resolves true.
 */
export function ConfirmSheet() {
  const { colors } = useTheme();
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const pending = useConfirmationStore((s) => s.pending);
  const resolveConfirmation = useConfirmationStore(
    (s) => s.resolveConfirmation,
  );
  const [isConfirmArmed, setIsConfirmArmed] = useState(false);

  useEffect(() => {
    setIsConfirmArmed(false);
    if (!pending) return;
    const timer = setTimeout(
      () => setIsConfirmArmed(true),
      CONFIRM_ARM_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [pending]);

  if (!pending) return null;
  const { title, message, detail, confirmLabel, cancelLabel } = pending.request;
  const handleCancel = () => resolveConfirmation(false);
  const handleConfirm = () => resolveConfirmation(true);

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      onRequestClose={handleCancel}
    >
      <Pressable
        style={[
          styles.backdrop,
          { backgroundColor: withAlpha(colors.background.main, 0.5) },
        ]}
        onPress={handleCancel}
        accessibilityLabel="Dismiss"
        testID="confirm-sheet-backdrop"
      />
      <View
        style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}
        accessibilityViewIsModal
        testID="confirm-sheet"
      >
        <View style={styles.handle} />
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <Text style={styles.message}>{message}</Text>
        {detail ? (
          <View style={styles.detailBox}>
            <Text
              style={styles.detail}
              numberOfLines={3}
              selectable
              testID="confirm-sheet-detail"
            >
              {detail}
            </Text>
          </View>
        ) : null}
        <View style={styles.actions}>
          <Button
            title={confirmLabel}
            onPress={handleConfirm}
            disabled={!isConfirmArmed}
            size="lg"
          />
          <Button
            title={cancelLabel ?? DEFAULT_CANCEL_LABEL}
            onPress={handleCancel}
            variant="ghost"
            size="lg"
          />
        </View>
      </View>
    </Modal>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors, glass }) => ({
    backdrop: {
      ...({
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
      } as const),
    },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: spacing.xl,
      backgroundColor: colors.background.surface,
      borderTopLeftRadius: radii["2xl"],
      borderTopRightRadius: radii["2xl"],
      borderWidth: 1,
      borderColor: glass.borderColor,
    },
    handle: {
      alignSelf: "center",
      width: 40,
      height: 5,
      borderRadius: 3,
      marginTop: spacing.sm,
      marginBottom: spacing.lg,
      backgroundColor: colors.background.subtle,
    },
    title: {
      fontSize: typography.size.lg,
      fontWeight: typography.weight.semibold,
      color: colors.text.primary,
      marginBottom: spacing.sm,
    },
    message: {
      fontSize: typography.size.body,
      color: colors.text.secondary,
      lineHeight: 20,
    },
    detailBox: {
      marginTop: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radii.md,
      backgroundColor: colors.background.main,
    },
    detail: {
      fontSize: typography.size.body2,
      color: colors.text.primary,
    },
    actions: {
      marginTop: spacing.xl,
      gap: spacing.sm,
    },
  }));
