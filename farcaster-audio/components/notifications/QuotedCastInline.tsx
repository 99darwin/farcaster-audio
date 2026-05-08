import { Text, View } from "react-native";

import { useThemedStyles } from "@/hooks/useThemedStyles";
import type { NeynarCast } from "@/types/neynar";

interface QuotedCastInlineProps {
  cast: NeynarCast;
}

export function QuotedCastInline({ cast }: QuotedCastInlineProps) {
  const styles = useStyles();
  if (!cast?.author?.username) return null;

  return (
    <View style={styles.container}>
      <Text numberOfLines={1} style={styles.text}>
        <Text style={styles.username}>@{cast.author.username}</Text>
        <Text style={styles.body}> · {cast.text}</Text>
      </Text>
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    container: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.background.surface,
      borderLeftWidth: 3,
      borderLeftColor: colors.warning,
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 10,
      marginTop: 6,
    },
    text: {
      flex: 1,
    },
    username: {
      color: colors.text.secondary,
      fontWeight: "600",
    },
    body: {
      color: colors.text.placeholder,
      fontWeight: "400",
    },
  }));
