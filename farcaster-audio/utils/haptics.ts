import * as Haptics from "expo-haptics";

export const haptic = {
  selection: () => {
    Haptics.selectionAsync();
  },
  light: () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  },
  medium: () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  },
  rigid: () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid);
  },
  success: () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  },
  warning: () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  },
  error: () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  },
};
