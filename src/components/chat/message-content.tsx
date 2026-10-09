import { StyleSheet, Text, View } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import { CodeBlock } from './markdown/code-block';
import { InlineContent } from './markdown/inline-content';
import { parseMessageMarkdown } from './markdown/streaming-parser';
import { TableBlock } from './markdown/table-block';
import { assertNever, type MarkdownBlock } from './markdown/types';
import type { InlineCitation } from './web-search-presentation';

const noCitations: readonly InlineCitation[] = [];

interface BlockProps {
  block: MarkdownBlock;
  citations: readonly InlineCitation[];
}

function listMarker(checked: boolean | null, ordered: boolean, number: number): string {
  if (checked !== null) return checked ? '☑' : '☐';
  return ordered ? `${number}.` : '•';
}

function BlockList({ blocks, citations, compact = false }: {
  blocks: readonly MarkdownBlock[];
  citations: readonly InlineCitation[];
  compact?: boolean;
}) {
  return <View style={compact ? styles.compactBlocks : styles.blocks}>
    {blocks.map((block) => <ContentBlock key={block.key} block={block} citations={citations} />)}
  </View>;
}

function ContentBlock({ block, citations }: BlockProps) {
  const colors = useChatColors();

  switch (block.kind) {
    case 'paragraph':
      return <Text selectable style={[styles.body, { color: colors.text }]}>
        <InlineContent fragment={block.content} citations={citations} />
      </Text>;
    case 'heading':
      return <Text selectable accessibilityRole="header" style={[
        styles.heading, { color: colors.text, fontSize: block.level === 1 ? 23 : block.level === 2 ? 21 : 19 },
      ]}>
        <InlineContent fragment={block.content} citations={citations} />
      </Text>;
    case 'code':
      return <CodeBlock language={block.language} code={block.text} />;
    case 'list':
      return <View role="list" style={styles.list}>
        {block.items.map((item, index) => <View key={item.key} role="listitem" style={styles.listRow}>
          <Text style={[styles.listMarker, { color: colors.secondary }]}
            accessibilityLabel={item.checked === null ? undefined : item.checked ? 'Completed task' : 'Incomplete task'}>
            {listMarker(item.checked, block.ordered, block.start + index)}
          </Text>
          <View style={styles.listContent}><BlockList blocks={item.blocks} citations={citations} compact /></View>
        </View>)}
      </View>;
    case 'quote':
      return <View style={[styles.quote, { borderLeftColor: colors.border }]}>
        <BlockList blocks={block.blocks} citations={citations} />
      </View>;
    case 'rule':
      return <View style={[styles.rule, { backgroundColor: colors.border }]} />;
    case 'table':
      return <TableBlock block={block} citations={citations} />;
    default:
      return assertNever(block);
  }
}

/** Blocks are keyed by source offset, so completed blocks stay mounted as later content streams. */
export function MessageContent({ text, streaming = false, citations = noCitations }: {
  text: string;
  streaming?: boolean;
  citations?: readonly InlineCitation[];
}) {
  const blocks = parseMessageMarkdown(text, streaming);
  return <View style={styles.content}><BlockList blocks={blocks} citations={citations} /></View>;
}

const styles = StyleSheet.create({
  content: { minHeight: 25 },
  blocks: { gap: 12, minWidth: 0 },
  compactBlocks: { gap: 7, minWidth: 0 },
  body: { fontSize: 16, lineHeight: 25 },
  heading: { fontWeight: '600', lineHeight: 28, marginTop: 4 },
  list: { gap: 7 },
  listRow: { flexDirection: 'row', gap: 9 },
  listMarker: { minWidth: 20, fontSize: 16, lineHeight: 25 },
  listContent: { flex: 1, minWidth: 0 },
  quote: { borderLeftWidth: 3, paddingLeft: 13 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 6 },
});
