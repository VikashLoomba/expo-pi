import type { InlineFragment, MarkdownBlock } from './types';

export interface StreamingSource {
  readonly text: string;
  readonly changedAt: number;
  readonly pendingLinkAt?: number;
}

const pendingHref = 'https://streaming.invalid/';

/** These are presentation hints for an unfinished suffix, not Markdown grammar. */
function closingDelimiter(text: string, delimiter: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (!text.startsWith(delimiter, index)) continue;
    if (text[index - 1] !== delimiter[0] && text[index + delimiter.length] !== delimiter[0]) return index;
  }
  return -1;
}

function closingBracket(text: string, start: number, open: string, close: string): number {
  let depth = 1;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === open) depth++;
    if (text[index] === close && --depth === 0) return index;
  }
  return -1;
}

/** Add virtual closers only to the displayed suffix; source offsets before it stay intact. */
function completeInline(text: string, allowLinks = true): StreamingSource {
  let suffix = '';
  let end = text.length;
  for (let index = 0; index < end;) {
    const character = text[index];
    if (character === '\\') {
      if (index === end - 1) end--;
      index += 2;
      continue;
    }
    if (allowLinks && character === '[' && text[index - 1] !== '!') {
      const labelEnd = closingBracket(text, index + 1, '[', ']');
      const targetStart = labelEnd + 1;
      const hasTarget = labelEnd !== -1 && text[targetStart] === '(';
      const targetEnd = hasTarget ? closingBracket(text, targetStart + 1, '(', ')') : -1;
      if (labelEnd === -1 || targetStart === end || (hasTarget && targetEnd === -1)) {
        const labelText = text.slice(index + 1);
        const label = labelEnd === -1 ? completeInline(labelText, false) : undefined;
        // Balance label brackets without inventing nested links or image targets.
        let brackets = 0;
        if (label) for (let cursor = 0; cursor < labelText.length; cursor++) {
          if (labelText[cursor] === '\\') { cursor++; continue; }
          if (labelText[cursor] === '[') brackets++;
          if (labelText[cursor] === ']') brackets--;
        }
        return {
          text: text.slice(0, index + 1) + (label?.text ?? text.slice(index + 1, labelEnd)) + ']'.repeat(Math.max(0, brackets)) + `](${pendingHref})` + suffix,
          changedAt: labelEnd === -1 ? index + 1 + (label?.changedAt ?? 0) : targetStart,
          pendingLinkAt: index,
        };
      }
      if (targetEnd !== -1) { index = targetEnd + 1; continue; }
    }
    if (character === '`' || character === '*' || character === '_' || character === '~') {
      const match = text.slice(index).match(/^(`+|\*{1,3}|_{1,3}|~{2})/);
      if (!match || (character === '_' && /\w/.test(text[index - 1] ?? ''))) { index++; continue; }
      const delimiter = match[0];
      const close = closingDelimiter(text, delimiter, index + delimiter.length);
      if (close !== -1) { index = close + delimiter.length; continue; }
      if (index + delimiter.length === end) { end = index; break; }
      if (character !== '`' && /\s/.test(text[index + delimiter.length])) { index += delimiter.length; continue; }
      // A single trailing star may be the first half of a bold closer.
      if (delimiter.length === 2 && text.endsWith(character) && !text.endsWith(delimiter)) end--;
      suffix = delimiter + suffix;
      index += delimiter.length;
      if (character === '`') break;
      continue;
    }
    index++;
  }
  return { text: text.slice(0, end) + suffix, changedAt: end };
}

function lastLeaf(block: MarkdownBlock | undefined): { value: MarkdownBlock | InlineFragment; inTable: boolean } | undefined {
  if (!block) return undefined;
  switch (block.kind) {
    case 'paragraph': case 'heading': return { value: block.content, inTable: false };
    case 'list': return lastLeaf(block.items.at(-1)?.blocks.at(-1));
    case 'quote': return lastLeaf(block.blocks.at(-1));
    case 'table': {
      const cell = [...(block.rows.at(-1) ?? block.header).cells].reverse().find((value) => value.sourceText.length > 0);
      return cell ? { value: cell, inTable: true } : undefined;
    }
    default: return { value: block, inTable: false };
  }
}

export function prepareStreamingSource(text: string, blocks: readonly MarkdownBlock[]): StreamingSource {
  const live = lastLeaf(blocks.at(-1));
  const leaf = live?.value;
  const lineStart = Math.max(text.lastIndexOf('\n'), text.lastIndexOf('\r')) + 1;
  const tail = text.slice(lineStart);
  if (leaf && 'kind' in leaf && leaf.kind === 'code') {
    const opening = text.slice(leaf.key).match(/^ {0,3}(`{3,}|~{3,})/);
    const codeTail = leaf.text.split(/\r\n|\r|\n/).at(-1)?.trim() ?? '';
    if (opening && lineStart > leaf.key && codeTail.length < opening[1].length
      && codeTail.length > 0 && tail.trimEnd().endsWith(codeTail)
      && [...codeTail].every((character) => character === opening[1][0])) {
      return { text: text.slice(0, lineStart), changedAt: lineStart };
    }
    return { text, changedAt: text.length };
  }
  if (/^\s*(?:#{1,6}|`{1,2}|~{1,2}|[-+*]|\d+[.)]?)$/.test(tail)) {
    return { text: text.slice(0, lineStart), changedAt: lineStart };
  }
  // A pipe closes the last cell. It must not inherit optimism from the message.
  if (live?.inTable) {
    // Ragged rows are padded/truncated for layout; only a real cell at EOF is live.
    if (!leaf || !('runs' in leaf) || leaf.key + leaf.sourceText.length < text.length) return { text, changedAt: text.length };
    const ending = text.trimEnd();
    let escapes = 0;
    for (let index = ending.length - 2; index >= 0 && ending[index] === '\\'; index--) escapes++;
    if (/[\r\n]$/.test(text) || (ending.endsWith('|') && escapes % 2 === 0)) return { text, changedAt: text.length };
  }
  if (!leaf || !('runs' in leaf)) return { text, changedAt: text.length };
  const completed = completeInline(leaf.sourceText);
  return {
    text: text.slice(0, leaf.key) + completed.text + text.slice(leaf.key + leaf.sourceText.length),
    changedAt: leaf.key + completed.changedAt,
    ...(completed.pendingLinkAt === undefined ? {} : { pendingLinkAt: leaf.key + completed.pendingLinkAt }),
  };
}
