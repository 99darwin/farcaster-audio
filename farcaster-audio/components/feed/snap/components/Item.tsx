import { View, Text } from "react-native";
import type { ItemProps } from "@/types/snap";
import { useSnapContext } from "../context";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface Props {
  props: ItemProps;
  childIds?: string[];
  depth: number;
}

export function SnapItem({ props, childIds, depth }: Props) {
  const { renderChildren } = useSnapContext();
  const styles = useStyles();
  return (
    <View style={styles.item}>
      <Text style={styles.title} numberOfLines={2}>
        {props.title}
      </Text>
      {props.description ? (
        <Text style={styles.description} numberOfLines={3}>
          {props.description}
        </Text>
      ) : null}
      {childIds && childIds.length > 0 ? (
        <View style={styles.childrenWrap}>
          {renderChildren(childIds, depth + 1)}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    item: {
      paddingVertical: 8,
      paddingHorizontal: 10,
      gap: 2,
    },
    title: {
      color: colors.text.primary,
      fontSize: 14,
      fontWeight: "600" as const,
    },
    description: {
      color: colors.text.secondary,
      fontSize: 13,
      lineHeight: 17,
    },
    childrenWrap: {
      marginTop: 6,
      gap: 4,
    },
  }));
