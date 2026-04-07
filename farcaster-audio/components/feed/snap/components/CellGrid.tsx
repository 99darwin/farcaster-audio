import { View, Text, StyleSheet } from 'react-native';
import type { CellGridProps } from '@/types/snap';
import { useSnapContext, GAP_VALUES } from '../context';
import { resolvePaletteColor } from '@/constants/snapPalette';
import { colors } from '@/constants/theme';

export function SnapCellGrid({ props }: { props: CellGridProps }) {
  const { accent } = useSnapContext();
  const cols = Math.max(2, Math.min(32, props.cols));
  const rows = Math.max(2, Math.min(16, props.rows));
  const gap = GAP_VALUES[props.gap ?? 'sm'];
  const rowHeight = Math.max(8, Math.min(64, props.rowHeight ?? 28));

  // Index cells by "row:col" for O(1) lookup
  const cellMap = new Map<string, (typeof props.cells)[number]>();
  for (const cell of props.cells ?? []) {
    cellMap.set(`${cell.row}:${cell.col}`, cell);
  }

  const rowElements = [];
  for (let r = 0; r < rows; r++) {
    const cellElements = [];
    for (let c = 0; c < cols; c++) {
      const cell = cellMap.get(`${r}:${c}`);
      const bg = cell?.color
        ? resolvePaletteColor(cell.color, accent)
        : colors.background.surface;
      cellElements.push(
        <View
          key={c}
          style={[
            styles.cell,
            { backgroundColor: bg, height: rowHeight, marginRight: c < cols - 1 ? gap : 0 },
          ]}
        >
          {cell?.content ? (
            <Text style={styles.cellText} numberOfLines={1}>{cell.content}</Text>
          ) : null}
        </View>,
      );
    }
    rowElements.push(
      <View key={r} style={[styles.row, { marginBottom: r < rows - 1 ? gap : 0 }]}>
        {cellElements}
      </View>,
    );
  }

  return <View style={styles.grid}>{rowElements}</View>;
}

const styles = StyleSheet.create({
  grid: {},
  row: {
    flexDirection: 'row',
  },
  cell: {
    flex: 1,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  cellText: {
    color: colors.text.primary,
    fontSize: 10,
    fontWeight: '600',
  },
});
