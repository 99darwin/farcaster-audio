import { View, Text, StyleSheet } from 'react-native';
import type { ReactNode } from 'react';
import type { SnapElement } from '@/types/snap';
import { useSnapContext, MAX_RENDER_DEPTH } from './context';
import { isKnownElement } from '@/services/snapClient';
import { colors } from '@/constants/theme';

import { SnapText } from './components/Text';
import { SnapBadge } from './components/Badge';
import { SnapButton } from './components/Button';
import { SnapIcon } from './components/Icon';
import { SnapImage } from './components/Image';
import { SnapItem } from './components/Item';
import { SnapProgress } from './components/Progress';
import { SnapSeparator } from './components/Separator';
import { SnapStack } from './components/Stack';
import { SnapItemGroup } from './components/ItemGroup';
import { SnapBarChart } from './components/BarChart';
import { SnapCellGrid } from './components/CellGrid';
import { SnapInput } from './components/Input';
import { SnapSlider } from './components/Slider';
import { SnapSwitch } from './components/Switch';
import { SnapToggleGroup } from './components/ToggleGroup';

function Placeholder({ label }: { label: string }) {
  return (
    <View style={styles.placeholder}>
      <Text style={styles.placeholderText}>Unsupported: {label}</Text>
    </View>
  );
}

function renderElement(element: SnapElement, depth: number, id: string): ReactNode {
  switch (element.type) {
    case 'text':
      return <SnapText props={element.props} />;
    case 'badge':
      return <SnapBadge props={element.props} />;
    case 'button':
      return <SnapButton id={id} props={element.props} on={element.on} />;
    case 'icon':
      return <SnapIcon props={element.props} />;
    case 'image':
      return <SnapImage props={element.props} />;
    case 'item':
      return <SnapItem props={element.props} childIds={element.children} depth={depth} />;
    case 'progress':
      return <SnapProgress props={element.props} />;
    case 'separator':
      return <SnapSeparator props={element.props} />;
    case 'stack':
      return <SnapStack props={element.props} childIds={element.children} depth={depth} />;
    case 'item_group':
      return <SnapItemGroup props={element.props} childIds={element.children} depth={depth} />;
    case 'bar_chart':
      return <SnapBarChart props={element.props} />;
    case 'cell_grid':
      return <SnapCellGrid props={element.props} />;
    case 'input':
      return <SnapInput props={element.props} />;
    case 'slider':
      return <SnapSlider props={element.props} />;
    case 'switch':
      return <SnapSwitch props={element.props} />;
    case 'toggle_group':
      return <SnapToggleGroup props={element.props} />;
  }
  // Runtime fallback for shapes that bypassed static typing
  return <Placeholder label={(element as { type: string }).type} />;
}

interface SnapRendererProps {
  rootId: string;
  depth?: number;
}

export function SnapRenderer({ rootId, depth = 0 }: SnapRendererProps) {
  const { elements } = useSnapContext();

  if (depth > MAX_RENDER_DEPTH) {
    return <Placeholder label="max depth" />;
  }

  const element = elements[rootId];
  if (!element) return null;

  // Runtime guard — upstream validation may let unknown `type` strings through
  const maybeUnknown = element as { type: string };
  if (!isKnownElement(maybeUnknown)) {
    return <Placeholder label={maybeUnknown.type} />;
  }

  return <>{renderElement(element, depth, rootId)}</>;
}

const styles = StyleSheet.create({
  placeholder: {
    borderWidth: 1,
    borderColor: colors.background.border,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    backgroundColor: colors.background.surface,
  },
  placeholderText: {
    color: colors.text.secondary,
    fontSize: 11,
    fontStyle: 'italic',
  },
});
