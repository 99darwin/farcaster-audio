import { Fragment } from "react";
import { View, StyleSheet } from "react-native";
import type { ItemGroupProps } from "@/types/snap";
import { useSnapContext, GAP_VALUES } from "../context";
import { useThemedStyles } from "@/hooks/useThemedStyles";

interface Props {
  props: ItemGroupProps;
  childIds?: string[];
  depth: number;
}

export function SnapItemGroup({ props, childIds, depth }: Props) {
  const { elements, renderChildren } = useSnapContext();
  const styles = useStyles();
  const gap = GAP_VALUES[props.gap ?? "none"];

  const ids = childIds ?? [];

  return (
    <View
      style={[styles.group, props.border ? styles.bordered : null, { gap }]}
    >
      {props.separator
        ? ids.map((id, i) => {
            const el = elements[id];
            if (!el) return null;
            return (
              <Fragment key={id}>
                {i > 0 ? <View style={styles.sep} /> : null}
                {renderChildren([id], depth + 1)}
              </Fragment>
            );
          })
        : renderChildren(ids, depth + 1)}
    </View>
  );
}

const useStyles = () =>
  useThemedStyles(({ colors }) => ({
    group: {
      borderRadius: 10,
      overflow: "hidden" as const,
    },
    bordered: {
      borderWidth: 1,
      borderColor: colors.background.border,
    },
    sep: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.background.border,
    },
  }));
