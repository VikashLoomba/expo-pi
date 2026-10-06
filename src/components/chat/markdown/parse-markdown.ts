import type { Definition, Nodes, PhrasingContent, RootContent } from 'mdast';
import { fromMarkdown, type CompileContext, type Extension, type Token } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

import { safeSourceUrl } from '../../../chat/web-search-url';
import { joinMappedText, literalText, replaceMappedText, sliceMappedText, sourceRange } from './source-map';
import type { InlineFragment, InlineMark, InlineRun, MappedText, MarkdownBlock, TableRow } from './types';

interface TextToken { readonly start: number; readonly end: number; readonly value: MappedText }

const textTokenTypes = new Set([
  'data', 'characterEscapeValue', 'characterReference', 'codeTextData', 'lineEnding',
  'autolinkProtocol', 'autolinkEmail', 'literalAutolinkHttp', 'literalAutolinkWww', 'literalAutolinkEmail',
]);

function textTail(context: CompileContext): string {
  const parent = context.stack.at(-1);
  const tail = parent?.type === 'text' ? parent : parent && 'children' in parent ? parent.children.at(-1) : undefined;
  return tail?.type === 'text' ? tail.value : '';
}

/** Observe public compiler events instead of reimplementing escape/entity grammar. */
function sourceMapping(tokens: TextToken[], originalChildren: Map<Nodes, readonly Nodes[]>): Extension {
  const lengths = new Map<Token, number>();
  return {
    transforms: [(tree) => {
      const visit = (node: Nodes) => {
        if ('children' in node) {
          originalChildren.set(node, node.children.slice());
          node.children.forEach(visit);
        }
      };
      visit(tree);
    }],
    beforeEnter(token) {
      if (textTokenTypes.has(token.type)) lengths.set(token, textTail(this).length);
    },
    afterExit(token) {
      const length = lengths.get(token);
      if (length === undefined) return;
      lengths.delete(token);
      const text = textTail(this).slice(length);
      if (text) tokens.push({ start: token.start.offset, end: token.end.offset,
        value: literalText(text, token.start.offset, token.end.offset) });
    },
  };
}

function offsets(node: Nodes): { start: number; end: number } | undefined {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start === undefined || end === undefined ? undefined : { start, end };
}

/** Standards parsing is pure; live-suffix presentation and identity reuse live above it. */
export function parseMarkdown(source: string): readonly MarkdownBlock[] {
  const textTokens: TextToken[] = [];
  const originalChildren = new Map<Nodes, readonly Nodes[]>();
  // Observe the tree before GFM's autolink transform replaces text with unpositioned nodes.
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [sourceMapping(textTokens, originalChildren), gfmFromMarkdown()] });
  textTokens.sort((a, b) => a.start - b.start || a.end - b.end);
  const generatedText = new Map<Nodes, MappedText>();
  const generatedRanges = new Map<Nodes, { start: number; end: number }>();
  const rangeOf = (node: Nodes) => offsets(node) ?? generatedRanges.get(node);
  const definitions = new Map<string, Definition>();
  const collectDefinitions = (node: Nodes) => {
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if ('children' in node) node.children.forEach(collectDefinitions);
  };
  collectDefinitions(tree);

  const raw = (node: Nodes): MappedText => {
    const range = rangeOf(node);
    return range ? literalText(source.slice(range.start, range.end), range.start) : literalText('', 0);
  };
  const mappedLeaf = (node: Nodes & { value: string }, inTable: boolean): MappedText => {
    const generated = generatedText.get(node);
    if (generated) return generated;
    const range = rangeOf(node);
    if (!range) return literalText(node.value, 0, source.length);
    // A node may combine many concrete tokens; each token preserves its own raw range.
    let lower = 0;
    let upper = textTokens.length;
    while (lower < upper) {
      const middle = (lower + upper) >>> 1;
      if (textTokens[middle].start < range.start) lower = middle + 1;
      else upper = middle;
    }
    const parts: MappedText[] = [];
    for (let index = lower; index < textTokens.length && textTokens[index].start < range.end; index++) {
      if (textTokens[index].end <= range.end) parts.push(textTokens[index].value);
    }
    let mapped = joinMappedText(parts);
    if (node.type === 'inlineCode' && inTable) mapped = replaceMappedText(mapped, /\\[\\|]/g, (text) => text === '\\|' ? '|' : text);
    // Unknown extension output receives a conservative whole-node map, never guessed offsets.
    if (mapped.text !== node.value) mapped = literalText(node.value, range.start, range.end);
    return node.type === 'inlineCode' ? replaceMappedText(mapped, /\r\n|\r|\n/g, () => ' ') : mapped;
  };

  // GFM also recognizes autolinks after entity decoding. Its public transform creates
  // unpositioned children; project those children through the original text's map.
  const visibleText = (node: Nodes): string => node.type === 'text' ? node.value
    : 'children' in node ? node.children.map(visibleText).join('') : '';
  for (const [parent, original] of originalChildren) {
    if (!('children' in parent)) continue;
    let cursor = 0;
    for (const child of original) {
      if (parent.children[cursor] === child) { cursor++; continue; }
      if (child.type !== 'text') continue;
      const replacements: Nodes[] = [];
      while (cursor < parent.children.length && !parent.children[cursor].position) replacements.push(parent.children[cursor++]);
      if (!replacements.length || replacements.map(visibleText).join('') !== child.value) continue;
      const value = mappedLeaf(child, false);
      let position = 0;
      const assign = (node: Nodes) => {
        const start = position;
        if (node.type === 'text') {
          position += node.value.length;
          generatedText.set(node, sliceMappedText(value, start, position));
        } else if ('children' in node) node.children.forEach(assign);
        const range = sourceRange(value.sourceSpans, start, position);
        if (range) generatedRanges.set(node, range);
      };
      replacements.forEach(assign);
    }
  }
  const leafRun = (value: MappedText, key: number, marks: readonly InlineMark[], href?: string): InlineRun => ({
    key, ...value, marks, ...(href ? { href } : {}),
  });
  const inline = (nodes: readonly PhrasingContent[], marks: readonly InlineMark[] = [], href?: string, inTable = false): InlineRun[] => nodes.flatMap((node) => {
    const key = rangeOf(node)?.start ?? 0;
    switch (node.type) {
      case 'text': return [leafRun(mappedLeaf(node, inTable), key, marks, href)];
      case 'inlineCode': return [leafRun(mappedLeaf(node, inTable), key, [...marks, 'code'], href)];
      case 'strong': case 'emphasis': case 'delete': return inline(node.children, [...marks, node.type], href, inTable);
      case 'link': case 'linkReference': {
        const target = node.type === 'link' ? node.url : definitions.get(node.identifier)?.url;
        const url = safeSourceUrl(target);
        return url ? inline(node.children, marks, url, inTable) : [leafRun(raw(node), key, marks)];
      }
      case 'break': {
        const range = rangeOf(node);
        return [leafRun(literalText('\n', range?.start ?? key, range?.end ?? key + 1), key, marks, href)];
      }
      // No image fetches, HTML interpretation, or footnote navigation are implied by parsing.
      // Preserve their original Markdown visibly until dedicated UI exists.
      case 'image': case 'imageReference': case 'html': case 'footnoteReference':
        return [leafRun(raw(node), key, marks, href)];
    }
  });
  const fragment = (node: Nodes & { children: PhrasingContent[] }, inTable = false): InlineFragment => {
    const range = rangeOf(node);
    return { key: range?.start ?? 0, sourceText: range ? source.slice(range.start, range.end) : '', runs: inline(node.children, [], undefined, inTable) };
  };
  const rawParagraph = (node: Nodes): MarkdownBlock => {
    const value = raw(node);
    const key = offsets(node)?.start ?? 0;
    return { kind: 'paragraph', key, content: { key, sourceText: value.text, runs: [leafRun(value, key, [])] } };
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
