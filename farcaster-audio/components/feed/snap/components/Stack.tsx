import { View, StyleSheet } from 'react-native';
import type { StackProps } from '@/types/snap';
import { useSnapContext, GAP_VALUES } from '../context';

const JUSTIFY_MAP: Record<string, 'flex-start' | 'flex-end' | 'center' | 'space-between' | 'space-around'> = {
  start: 'flex-start',
  end: 'flex-end',
  center: 'center',
  between: 'space-between',
  around: 'space-around',
};

interface Props {
  props: StackProps;
  childIds?: string[];
  depth: number;
}

export function SnapStack({ props, childIds, depth }: Props) {
  const { renderChildren } = useSnapContext();
  const horizontal = props.direction === 'horizontal';
  const gap = GAP_VALUES[props.gap ?? 'md'];
  const justifyContent = props.justify ? JUSTIFY_MAP[props.justify] : undefined;

  return (
    <View
      style={[
        styles.stack,
        {
          flexDirection: horizontal ? 'row' : 'column',
          gap,
          justifyContent,
          alignItems: horizontal ? 'center' : 'stretch',
        },
      ]}
    >
      {renderChildren(childIds, depth + 1)}
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    flexShrink: 1,
  },
});
