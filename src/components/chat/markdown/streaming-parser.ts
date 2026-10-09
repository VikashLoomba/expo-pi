import { parseMarkdown } from './parse-markdown';
import { sliceMappedText, sourceRange } from './source-map';
import { prepareStreamingSource, type StreamingSource } from './streaming-source';
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

/** Virtual closers never become archived text or provider citation coordinates. */
function restoreSource(blocks: readonly MarkdownBlock[], source: string, prepared: StreamingSource): readonly MarkdownBlock[] {
  return mapBlocks(blocks, (value) => {
    const end = value.key + value.sourceText.length >= prepared.changedAt ? source.length : value.key + value.sourceText.length;
    return {
      ...value,
      sourceText: source.slice(value.key, end),
      runs: value.runs.flatMap((run) => {
        let end = 0;
        for (const character of run.text) {
          const range = sourceRange(run.sourceSpans, end, end + character.length);
          if (!range || range.end > prepared.changedAt) break;
          end += character.length;
        }
        if (!end) return [];
        return [{ ...run, ...sliceMappedText(run, 0, end),
          ...(prepared.pendingLinkAt !== undefined && run.key > prepared.pendingLinkAt && run.href === 'https://streaming.invalid/' ? { href: null } : {}),
        }];
      }),
    };
  });
}

/** A message's blocks. While it streams, an unfinished suffix is shown with virtual closers. */
export function parseMessageMarkdown(text: string, streaming: boolean): readonly MarkdownBlock[] {
  const blocks = parseMarkdown(text);
  if (!streaming) return blocks;
  const prepared = prepareStreamingSource(text, blocks);
  return prepared.text === text ? blocks : restoreSource(parseMarkdown(prepared.text), text, prepared);
}
