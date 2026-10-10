import type { Definition, Nodes, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

import { safeSourceUrl } from '../../../chat/web-search-url';
import type { InlineFragment, InlineMark, InlineRun, MarkdownBlock, TableRow } from './types';

function offsets(node: Nodes): { start: number; end: number } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : { start, end };
}

type DraftRun = Omit<InlineRun, 'key'> & { key?: number };

/** Standards parsing is pure; live-suffix presentation lives above it. */
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  // GFM's autolink transform creates unpositioned nodes; their runs fall back to ordinal keys in fragment().
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  const definitions = new Map<string, Definition>();
  const collectDefinitions = (node: Nodes) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if ('children' in node) node.children.forEach(collectDefinitions);
  };
  collectDefinitions(tree);

  const raw = (node: Nodes): string => {
    const range = offsets(node);
    return range ? source.slice(range.start, range.end) : '';
  };
  const leafValue = (node: Nodes & { value: string }, inTable: boolean): string => {
    // Escaped pipes survive GFM table cells only inside inline code; newlines leave inline code.
    const unescaped = inTable && node.type === 'inlineCode'
      ? node.value.replace(/\\[\\|]/g, (match) => (match === '\\|' ? '|' : match)) : node.value;
    return node.type === 'inlineCode' ? unescaped.replace(/\r\n|\r|\n/g, ' ') : unescaped;
  };

  const leafRun = (value: string, key: number | undefined, marks: readonly InlineMark[], href?: string): DraftRun[] =>
    value ? [{ key, text: value, marks, ...(href ? { href } : {}) }] : [];
  const inline = (nodes: readonly PhrasingContent[], marks: readonly InlineMark[] = [], href?: string,
    inTable = false): DraftRun[] => nodes.flatMap((node): DraftRun[] => {
    const key = offsets(node)?.start;
    switch (node.type) {
      case 'text': return leafRun(leafValue(node, inTable), key, marks, href);
      case 'inlineCode': return leafRun(leafValue(node, inTable), key, [...marks, 'code'], href);
      case 'strong': case 'emphasis': case 'delete': return inline(node.children, [...marks, node.type], href, inTable);
      case 'link': case 'linkReference': {
        const target = node.type === 'link' ? node.url : definitions.get(node.identifier)?.url;
        const url = safeSourceUrl(target);
        return url ? inline(node.children, marks, url, inTable) : leafRun(raw(node), key, marks);
      }
      case 'break': return [{ key, text: '\n', marks, ...(href ? { href } : {}) }];
      // No image fetches, HTML interpretation, or footnote navigation are implied by parsing.
      // Preserve their original Markdown visibly until dedicated UI exists.
      case 'image': case 'imageReference': case 'html': case 'footnoteReference':
        return leafRun(raw(node), key, marks, href);
    }
  });
  const fragment = (node: Nodes & { children: PhrasingContent[] }, inTable = false): InlineFragment => {
    const range = offsets(node);
    return {
      key: range?.start ?? 0,
      sourceText: range ? source.slice(range.start, range.end) : '',
      // Runs from extension transforms (autolinks) have no position; ordinal keys, which static content keeps.
      runs: inline(node.children, [], undefined, inTable)
        .map((run, index) => ({ ...run, key: run.key ?? -(index + 1) })),
    };
  };
  const rawParagraph = (node: Nodes): MarkdownBlock => {
    const value = raw(node);
    const key = offsets(node)?.start ?? 0;
    return { kind: 'paragraph', key,
      content: { key, sourceText: value, runs: value ? [{ key, text: value, marks: [] }] : [] } };
  };
  const blocks = (nodes: readonly RootContent[]): MarkdownBlock[] => nodes.flatMap((node): MarkdownBlock[] => {
    const key = offsets(node)?.start ?? 0;
    switch (node.type) {
      case 'paragraph': return [{ kind: 'paragraph', key, content: fragment(node) }];
      case 'heading': return [{ kind: 'heading', key, level: node.depth, content: fragment(node) }];
      case 'code': return [{ kind: 'code', key, text: node.value, language: node.lang ?? '' }];
      case 'blockquote': return [{ kind: 'quote', key, blocks: blocks(node.children) }];
      case 'thematicBreak': return [{ kind: 'rule', key }];
      case 'list': return [{ kind: 'list', key, ordered: node.ordered ?? false, start: node.start ?? 1,
        items: node.children.map((item) => ({ key: offsets(item)?.start ?? key, checked: item.checked ?? null, blocks: blocks(item.children) })) }];
      case 'table': {
        const width = node.children[0]?.children.length ?? 0;
        const row = (value: typeof node.children[number]): TableRow => ({ key: offsets(value)?.start ?? key,
          cells: Array.from({ length: width }, (_, index) => {
            const cell = value.children[index];
            return cell ? fragment(cell, true) : { key: (offsets(value)?.end ?? key) + index, sourceText: '', runs: [] };
          }) });
        return width ? [{ kind: 'table', key, alignments: Array.from({ length: width }, (_, index) => node.align?.[index] ?? null),
          header: row(node.children[0]), rows: node.children.slice(1).map(row) }] : [];
      }
      case 'definition': return [];
      case 'html': case 'footnoteDefinition': return [rawParagraph(node)];
      // mdast permits fragment roots and additional extension nodes. Their original
      // source remains visible until the native model has an explicit representation.
      default: return [rawParagraph(node)];
    }
  });
  return blocks(tree.children);
}
