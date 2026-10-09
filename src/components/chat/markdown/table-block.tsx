import { memo, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import type { InlineCitation } from '../web-search-presentation';
import { InlineContent } from './inline-content';
import type { ColumnAlignment, MarkdownBlock, TableRow } from './types';

type Table = Extract<MarkdownBlock, { kind: 'table' }>;

const Row = memo(function Row({ row, header, rowNumber, columnWidth, alignments, citations }: {
  row: TableRow;
  header: boolean;
  rowNumber: number;
  columnWidth: number;
  alignments: readonly ColumnAlignment[];
  citations: readonly InlineCitation[];
}) {
  const colors = useChatColors();
  return <View style={[styles.row, { borderBottomColor: colors.border, backgroundColor: header ? colors.subtle : colors.surface }]}>
    {row.cells.map((cell, index) => <View key={`${row.key}:${index}`} style={[
      styles.cell,
      { width: columnWidth, borderRightWidth: index === row.cells.length - 1 ? 0 : StyleSheet.hairlineWidth, borderRightColor: colors.border },
    ]}>
      <Text selectable accessibilityRole={header ? 'header' : undefined}
        accessibilityHint={`${header ? 'Header' : `Row ${rowNumber}`}, column ${index + 1}`}
        style={[styles.text, header && styles.headerText, { color: colors.text, textAlign: alignments[index] ?? 'left' }]}>
        <InlineContent fragment={cell} citations={citations} />
      </Text>
    </View>)}
  </View>;
});

/** One scroller and shared column widths keep all rows aligned during streaming. */
export function TableBlock({ block, citations }: { block: Table; citations: readonly InlineCitation[] }) {
  const colors = useChatColors();
  const { fontScale } = useWindowDimensions();
  const [viewportWidth, setViewportWidth] = useState(0);
  const columnCount = Math.max(1, block.header.cells.length);
  // Width depends on the viewport and font scaling, never changing cell text.
  const columnWidth = Math.max(144 * fontScale, viewportWidth / columnCount);
  const tableWidth = columnWidth * columnCount;

  return <View testID={`markdown-table-${block.key}`} style={[styles.container, { borderColor: colors.border }]}>
    <ScrollView horizontal showsHorizontalScrollIndicator={tableWidth > viewportWidth}
      accessibilityRole="grid" accessibilityLabel={`Table with ${columnCount} columns and ${block.rows.length} data rows`}
      onLayout={({ nativeEvent }) => setViewportWidth(nativeEvent.layout.width)}
      alwaysBounceHorizontal={false} contentContainerStyle={{ width: tableWidth }}>
      <View style={{ width: tableWidth }}>
        <Row row={block.header} header rowNumber={0} columnWidth={columnWidth} alignments={block.alignments} citations={citations} />
        {block.rows.map((row, index) => <Row key={row.key} row={row} header={false} rowNumber={index + 1}
          columnWidth={columnWidth} alignments={block.alignments} citations={citations} />)}
      </View>
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  container: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, overflow: 'hidden', minWidth: 0 },
  row: { flexDirection: 'row', borderBottomWidth: StyleSheet.hairlineWidth },
  cell: { paddingHorizontal: 12, paddingVertical: 10 },
  text: { fontSize: 15, lineHeight: 23 },
  headerText: { fontWeight: '600' },
});
