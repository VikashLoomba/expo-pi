import { parseMarkdown } from './parse-markdown';
import { PENDING_HREF, prepareStreamingSource } from './streaming-source';
import { assertNever, type InlineFragment, type MarkdownBlock, type TableRow } from './types';

function mapBlocks(blocks: readonly MarkdownBlock[],
  fragment: (value: InlineFragment) => InlineFragment): readonly MarkdownBlock[] {
  const row = (value: TableRow): TableRow => ({ ...value, cells: value.cells.map(fragment) });
  return blocks.map((block): MarkdownBlock => {
    switch (block.kind) {
      case 'paragraph': return { ...block, content: fragment(block.content) };
      case 'heading': return { ...block, content: fragment(block.content) };
      case 'list': return { ...block, items: block.items.map((item) => ({ ...item,
        blocks: mapBlocks(item.blocks, fragment) })) };
      case 'quote': return { ...block, blocks: mapBlocks(block.blocks, fragment) };
      case 'table': return { ...block, header: row(block.header), rows: block.rows.map(row) };
      case 'code': case 'rule': return block;
      default: return assertNever(block);
    }
  });
}

/** The repaired fragment is the last one in document order; block and fragment keys are source offsets. */
function lastFragmentKey(blocks: readonly MarkdownBlock[]): number | undefined {
  let key: number | undefined;
  const visit = (fragment: InlineFragment) => { key = fragment.key; };
  const walk = (values: readonly MarkdownBlock[]) => {
    for (const block of values) {
      if (block.kind === 'paragraph' || block.kind === 'heading') visit(block.content);
      else if (block.kind === 'list') block.items.forEach((item) => walk(item.blocks));
      else if (block.kind === 'quote') walk(block.blocks);
      else if (block.kind === 'table') [block.header, ...block.rows].forEach((row) => row.cells.forEach(visit));
    }
  };
  walk(blocks);
  return key;
}

/**
 * A message's blocks. While it streams, an unfinished suffix is shown with virtual closers: re-parse the prepared
 * text, filter the pending-link sentinel href by value (a visible label, not a link), and key the repaired
 * fragment's runs by index — they re-parse as the suffix grows.
 */
export function parseMessageMarkdown(text: string, streaming: boolean): readonly MarkdownBlock[] {
  const blocks = parseMarkdown(text);
  if (!streaming) return blocks;
  const prepared = prepareStreamingSource(text, blocks);
  if (prepared.text === text) return blocks;
  const repairedKey = lastFragmentKey(blocks);
  return mapBlocks(parseMarkdown(prepared.text), (fragment) => ({
    ...fragment,
    runs: fragment.runs.map((run, index) => ({
      ...run,
      key: fragment.key === repairedKey ? index : run.key,
      href: run.href === PENDING_HREF ? null : run.href,
    })),
  }));
}
