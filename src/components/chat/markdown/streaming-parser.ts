import { parseMarkdown } from './parse-markdown';
import { sliceMappedText, sourceRange } from './source-map';
import { prepareStreamingSource, type StreamingSource } from './streaming-source';
import { assertNever, type InlineFragment, type MarkdownBlock, type TableRow } from './types';

function sameFragment(a: InlineFragment, b: InlineFragment): boolean {
  return a.key === b.key && a.sourceText === b.sourceText && a.runs.length === b.runs.length
    && a.runs.every((run, index) => {
      const other = b.runs[index];
      return run.key === other.key && run.text === other.text && run.href === other.href
        && run.marks.length === other.marks.length && run.marks.every((mark, i) => mark === other.marks[i])
        && run.sourceSpans.length === other.sourceSpans.length && run.sourceSpans.every((span, i) => {
          const next = other.sourceSpans[i];
          return span.start === next.start && span.end === next.end && span.sourceStart === next.sourceStart && span.sourceEnd === next.sourceEnd;
        });
    });
}

function shareRow(previous: TableRow | undefined, next: TableRow): TableRow {
  if (!previous || previous.key !== next.key) return next;
  const cells = next.cells.map((cell, index) => previous.cells[index] && sameFragment(previous.cells[index], cell) ? previous.cells[index] : cell);
  return cells.length === previous.cells.length && cells.every((cell, index) => cell === previous.cells[index])
    ? previous : { ...next, cells };
}

/** Reuse immutable views independently of how the grammar parser obtained its nodes. */
function shareBlocks(previous: readonly MarkdownBlock[], next: readonly MarkdownBlock[]): readonly MarkdownBlock[] {
  const byKey = new Map(previous.map((block) => [block.key, block]));
  const shared = next.map((block): MarkdownBlock => {
    const old = byKey.get(block.key);
    if (!old || old.kind !== block.kind) return block;
    switch (block.kind) {
      case 'paragraph': return old.kind === 'paragraph' && sameFragment(old.content, block.content) ? old : block;
      case 'heading': return old.kind === 'heading' && old.level === block.level && sameFragment(old.content, block.content) ? old : block;
      case 'code': return old.kind === 'code' && old.text === block.text && old.language === block.language ? old : block;
      case 'rule': return old;
      case 'quote': {
        if (old.kind !== 'quote') return block;
        const blocks = shareBlocks(old.blocks, block.blocks);
        return blocks === old.blocks ? old : { ...block, blocks };
      }
      case 'list': {
        if (old.kind !== 'list') return block;
        const items = block.items.map((item, index) => {
          const before = old.items[index];
          if (!before || before.key !== item.key) return item;
          const blocks = shareBlocks(before.blocks, item.blocks);
          return blocks === before.blocks && before.checked === item.checked ? before : { ...item, blocks };
        });
        return old.ordered === block.ordered && old.start === block.start && items.length === old.items.length
          && items.every((item, i) => item === old.items[i]) ? old : { ...block, items };
      }
      case 'table': {
        if (old.kind !== 'table') return block;
        const header = shareRow(old.header, block.header);
        const rows = block.rows.map((row, index) => shareRow(old.rows[index], row));
        return header === old.header && rows.length === old.rows.length && rows.every((row, i) => row === old.rows[i])
          && old.alignments.length === block.alignments.length && old.alignments.every((align, i) => align === block.alignments[i])
          ? old : { ...block, header, rows };
      }
      default: return assertNever(block);
    }
  });
  return shared.length === previous.length && shared.every((block, i) => block === previous[i]) ? previous : shared;
}

function mapBlocks(blocks: readonly MarkdownBlock[], key: (value: number) => number,
  fragment: (value: InlineFragment) => InlineFragment): readonly MarkdownBlock[] {
  const row = (value: TableRow): TableRow => ({ key: key(value.key), cells: value.cells.map(fragment) });
  return blocks.map((block): MarkdownBlock => {
    const base = { ...block, key: key(block.key) };
    switch (block.kind) {
      case 'paragraph': return { ...base, kind: 'paragraph', content: fragment(block.content) };
      case 'heading': return { ...base, kind: 'heading', level: block.level, content: fragment(block.content) };
      case 'list': return { ...block, key: key(block.key), items: block.items.map((item) => ({ ...item,
        key: key(item.key), blocks: mapBlocks(item.blocks, key, fragment) })) };
      case 'quote': return { ...block, key: key(block.key), blocks: mapBlocks(block.blocks, key, fragment) };
      case 'table': return { ...block, key: key(block.key), header: row(block.header), rows: block.rows.map(row) };
      case 'code': case 'rule': return { ...block, key: key(block.key) };
      default: return assertNever(block);
    }
  });
}

function parseFrom(source: string, start: number): readonly MarkdownBlock[] {
  const blocks = parseMarkdown(source.slice(start));
  if (!start) return blocks;
  return mapBlocks(blocks, (key) => key + start, (fragment) => ({ ...fragment, key: fragment.key + start,
    runs: fragment.runs.map((run) => ({ ...run, key: run.key + start,
      sourceSpans: run.sourceSpans.map((span) => ({ ...span, sourceStart: span.sourceStart + start,
        ...(span.sourceEnd === undefined ? {} : { sourceEnd: span.sourceEnd + start }) })),
    })),
  }));
}

/** Virtual closers never become archived text or provider citation coordinates. */
function restoreSource(blocks: readonly MarkdownBlock[], source: string, prepared: StreamingSource): readonly MarkdownBlock[] {
  return mapBlocks(blocks, (key) => key, (value) => {
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

// Definitions are document-scoped and can change earlier reference links. Be
// conservative, including partial labels and definitions in lists/block quotes.
const possibleDefinition = /(?:^|[\r\n])[\t >*+\-\d.)]*\[/;

/**
 * Keep two trailing top-level blocks mutable: an incomplete opener can still
 * rejoin its predecessor. Document-scoped definitions use the full-parse path.
 * Structural sharing is separate from grammar and never mutates returned nodes.
 */
export function createMarkdownParser() {
  let previousText = '';
  let previousStreaming = false;
  let previous: readonly MarkdownBlock[] = [];
  let grammar: readonly MarkdownBlock[] = [];
  return (text: string, streaming = false): readonly MarkdownBlock[] => {
    if (text === previousText && streaming === previousStreaming) return previous;
    const canReusePrefix = previousStreaming && text.startsWith(previousText) && !possibleDefinition.test(text);
    const prefix = canReusePrefix ? grammar.slice(0, Math.max(0, grammar.length - 2)) : [];
    const pivot = prefix.length ? grammar[prefix.length].key : 0;
    // AST keys can follow indentation; retain the original first-line context.
    const start = pivot ? Math.max(text.lastIndexOf('\n', pivot - 1), text.lastIndexOf('\r', pivot - 1)) + 1 : 0;
    grammar = [...prefix, ...parseFrom(text, start)];
    let blocks = grammar;
    if (streaming) {
      const prepared = prepareStreamingSource(text, blocks);
      if (prepared.text !== text) {
        // Repair only after the stable prefix; the same suffix policy is used by
        // an uncached parse and verified at every character boundary in tests.
        blocks = [...prefix, ...restoreSource(parseFrom(prepared.text, start), text, prepared)];
      }
    }
    previous = shareBlocks(previous, blocks);
    previousText = text;
    previousStreaming = streaming;
    return previous;
  };
}
