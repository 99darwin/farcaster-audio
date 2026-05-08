import {
  View,
  Text,
  Pressable,
  Modal,
  ScrollView,
  TextInput,
} from "react-native";
import { useState } from "react";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { typography } from "@/constants/theme";
import { useTheme } from "@/hooks/useTheme";
import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { AddedMiniApp } from "@/stores/miniappStore";

interface MiniAppPickerProps {
  visible: boolean;
  onClose: () => void;
  addedMiniApps: AddedMiniApp[];
  onSelectMiniApp: (miniApp: AddedMiniApp) => void;
}

export function MiniAppPicker({
  visible,
  onClose,
  addedMiniApps,
  onSelectMiniApp,
}: MiniAppPickerProps) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const styles = useStyles();
  const [urlInput, setUrlInput] = useState("");

  const handleOpenUrl = () => {
    const trimmed = urlInput.trim();
    if (!trimmed) return;

    const fullUrl = trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;

    // Validate: must be HTTPS, no private/local IPs
    try {
      const parsed = new URL(fullUrl);
      if (parsed.protocol !== "https:") return;
      const host = parsed.hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0")
        return;
      if (
        host.startsWith("192.168.") ||
        host.startsWith("10.") ||
        host.startsWith("172.")
      )
        return;
      if (host.endsWith(".local")) return;
    } catch {
      return;
    }

    const domain = getDomain(fullUrl);
    onSelectMiniApp({
      domain,
      config: {
        version: "1",
        name: domain,
        homeUrl: fullUrl,
        iconUrl: "",
        imageUrl: "",
        buttonTitle: "Open",
      },
      addedAt: new Date().toISOString(),
      notificationsEnabled: false,
    });
    setUrlInput("");
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable
          style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}
        >
          <View style={styles.handle} />
          <Text style={styles.title}>Mini Apps</Text>

          {/* URL Input */}
          <View style={styles.urlRow}>
            <TextInput
              style={styles.urlInput}
              value={urlInput}
              onChangeText={setUrlInput}
              placeholder="Enter miniapp URL..."
              placeholderTextColor={colors.text.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={handleOpenUrl}
            />
            <Pressable
              onPress={handleOpenUrl}
              style={[
                styles.goButton,
                !urlInput.trim() && styles.goButtonDisabled,
              ]}
              disabled={!urlInput.trim()}
            >
              <Ionicons
                name="arrow-forward"
                size={20}
                color={colors.text.primary}
              />
            </Pressable>
          </View>

          {/* Added Mini Apps */}
          {addedMiniApps.length > 0 ? (
            <ScrollView
              style={styles.list}
              showsVerticalScrollIndicator={false}
            >
              {addedMiniApps.map((app) => (
                <Pressable
                  key={app.domain}
                  style={styles.appRow}
                  onPress={() => onSelectMiniApp(app)}
                >
                  {app.config.iconUrl ? (
                    <Image
                      source={{ uri: app.config.iconUrl }}
                      style={styles.appIcon}
                      contentFit="cover"
                    />
                  ) : (
                    <View style={[styles.appIcon, styles.appIconPlaceholder]}>
                      <Ionicons
                        name="cube-outline"
                        size={20}
                        color={colors.text.secondary}
                      />
                    </View>
                  )}
                  <View style={styles.appInfo}>
                    <Text style={styles.appName} numberOfLines={1}>
                      {app.config.name}
                    </Text>
                    <Text style={styles.appDomain} numberOfLines={1}>
                      {app.domain}
                    </Text>
                  </View>
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color={colors.text.secondary}
                  />
                </Pressable>
              ))}
            </ScrollView>
          ) : (
            <View style={styles.emptyState}>
              <Ionicons
                name="apps-outline"
                size={32}
                color={colors.text.secondary}
              />
              <Text style={styles.emptyText}>No mini apps added yet</Text>
              <Text style={styles.emptySubtext}>
                Mini apps you add from casts will appear here
              </Text>
            </View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function getDomain(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname;
  } catch {
    return url;
  }
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0, 0, 0, 0.5)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: colors.background.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 16,
      maxHeight: "70%",
    },
    handle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.background.subtle,
      alignSelf: "center",
      marginBottom: 16,
    },
    title: {
      color: colors.text.primary,
      fontSize: typography.size.xl,
      fontWeight: typography.weight.bold,
      marginBottom: 16,
    },
    urlRow: {
      flexDirection: "row",
      gap: 8,
      marginBottom: 16,
    },
    urlInput: {
      flex: 1,
      backgroundColor: colors.background.main,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      color: colors.text.primary,
      fontSize: typography.size.body,
      borderWidth: 1,
      borderColor: colors.background.border,
    },
    goButton: {
      width: 44,
      height: 44,
      borderRadius: 12,
      backgroundColor: colors.purple,
      alignItems: "center",
      justifyContent: "center",
    },
    goButtonDisabled: {
      opacity: 0.4,
    },
    list: {
      maxHeight: 300,
    },
    appRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 10,
      gap: 12,
    },
    appIcon: {
      width: 40,
      height: 40,
      borderRadius: 10,
    },
    appIconPlaceholder: {
      backgroundColor: colors.background.main,
      alignItems: "center",
      justifyContent: "center",
    },
    appInfo: {
      flex: 1,
    },
    appName: {
      color: colors.text.primary,
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
    },
    appDomain: {
      color: colors.text.secondary,
      fontSize: typography.size.sm,
    },
    emptyState: {
      alignItems: "center",
      paddingVertical: 32,
      gap: 8,
    },
    emptyText: {
      color: colors.text.secondary,
      fontSize: typography.size.body,
      fontWeight: typography.weight.semibold,
    },
    emptySubtext: {
      color: colors.text.placeholder,
      fontSize: typography.size.sm,
      textAlign: "center",
    },
  }));
