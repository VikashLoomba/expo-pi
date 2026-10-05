export interface MarkdownBlock {
  /** Source offsets stay fixed as later tokens arrive. */
  readonly key: number;
  readonly kind: 'paragraph' | 'heading' | 'list-item' | 'code';
  readonly text: string;
  readonly level?: number;
  readonly marker?: string;
  readonly indent?: number;
  readonly language?: string;
  readonly sourceSpans?: readonly SourceSpan[];
}

/** A run in rendered text mapped to the original, unmodified source. */
export interface SourceSpan { readonly start: number; readonly end: number; readonly sourceStart: number }

export interface InlineToken {
  readonly key: number;
  readonly kind: 'text' | 'strong' | 'emphasis' | 'code' | 'link';
  readonly text: string;
  readonly href?: string;
  readonly sourceSpans?: readonly SourceSpan[];
}

interface Line { start: number; end: number; text: string; complete: boolean }
interface Draft {
  block: MarkdownBlock;
  lines: string[];
  lineStarts?: number[];
  fence?: string;
}

function* lines(text: string, start: number): Generator<Line> {
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const complete = newline !== -1;
    const end = complete ? newline + 1 : text.length;
    yield { start, end, text: text.slice(start, complete ? newline : end).replace(/\r$/, ''), complete };
    start = end;
  }
}

function sameBlock(a: MarkdownBlock | undefined, b: MarkdownBlock): boolean {
  return !!a && a.key === b.key && a.kind === b.kind && a.text === b.text && a.level === b.level
    && a.marker === b.marker && a.indent === b.indent && a.language === b.language
    && a.sourceSpans?.length === b.sourceSpans?.length
    && (a.sourceSpans?.every((span, index) => {
      const other = b.sourceSpans![index];
      return span.start === other.start && span.end === other.end && span.sourceStart === other.sourceStart;
    }) ?? true);
}

function parseTail(text: string, start: number, streaming: boolean, trackSource: boolean) {
  const blocks: MarkdownBlock[] = [];
  let draft: Draft | undefined;
  let stableCount = 0;
  let stableEnd = start;
  const flush = (stable: boolean, end: number) => {
    if (draft) {
      let position = 0;
      const sourceSpans = trackSource ? draft.lines.flatMap((line, index) => {
        const span = { start: position, end: position + line.length, sourceStart: draft!.lineStarts?.[index] ?? 0 };
        position += line.length + 1;
        return line.length ? [span] : [];
      }) : undefined;
      blocks.push({ ...draft.block, text: draft.lines.join('\n'), ...(trackSource ? { sourceSpans } : {}) });
      draft = undefined;
    }
    if (stable) { stableCount = blocks.length; stableEnd = end; }
  };

  for (const line of lines(text, start)) {
    const liveTail = streaming && !line.complete;
    if (draft?.fence) {
      const trimmed = line.text.trim();
      const fenceCharacter = draft.fence[0];
      if (trimmed.length >= draft.fence.length && [...trimmed].every((character) => character === fenceCharacter)) {
        // An unterminated closing line can still become code, e.g. ```suffix.
        flush(!liveTail, line.end);
      } else if (!(liveTail && trimmed.length > 0 && trimmed.length < draft.fence.length
        && [...trimmed].every((character) => character === fenceCharacter))) {
        // Do not briefly print the first one/two ticks of a closing fence.
        draft.lines.push(line.text);
        draft.lineStarts?.push(line.start);
      }
      continue;
    }
    if (!line.text.trim()) {
      flush(!liveTail, line.end);
      continue;
    }
    if (liveTail && /^\s*(?:#{1,6}|`{1,2}|~{1,2}|[-+*]|\d+[.)]?)$/.test(line.text)) {
      // Hold only an ambiguous block marker, never the paragraph preceding it.
      // The next character decides whether this is Markdown or ordinary text.
      continue;
    }
    const fence = line.text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence && (fence[1][0] !== '`' || !fence[2].includes('`'))) {
      // Later characters can invalidate an unfinished opening fence. Retain
      // the preceding paragraph in the mutable suffix until this line ends.
      flush(!liveTail, line.start);
      draft = { block: { key: line.start, kind: 'code', text: '', language: fence[2].trim() }, lines: [], lineStarts: trackSource ? [] : undefined, fence: fence[1] };
      continue;
    }
    const heading = line.text.match(/^ {0,3}(#{1,6})[\t ]+(.*)$/);
    if (heading) {
      flush(!liveTail, line.start);
      draft = { block: { key: line.start, kind: 'heading', text: '', level: heading[1].length }, lines: [heading[2]],
        lineStarts: trackSource ? [line.start + line.text.length - heading[2].length] : undefined };
      if (line.complete) flush(true, line.end);
      continue;
    }
    const item = line.text.match(/^(\s*)([-+*]|\d+[.)])[\t ]+(.*)$/);
    if (item) {
      flush(!liveTail, line.start);
      draft = { block: { key: line.start, kind: 'list-item', text: '', marker: /^\d/.test(item[2]) ? item[2] : '•',
        indent: Math.min(item[1].length, 12) }, lines: [item[3]],
        lineStarts: trackSource ? [line.start + line.text.length - item[3].length] : undefined };
      continue;
    }
    if (draft?.block.kind === 'list-item') {
      if (/^\s{2,}\S/.test(line.text)) {
        draft.lines.push(line.text.trimStart());
        draft.lineStarts?.push(line.start + line.text.length - line.text.trimStart().length);
        continue;
      }
      flush(true, line.start);
    }
    if (!draft) draft = { block: { key: line.start, kind: 'paragraph', text: '' }, lines: [], lineStarts: trackSource ? [] : undefined };
    draft.lines.push(line.text);
    draft.lineStarts?.push(line.start);
  }
  flush(!streaming, text.length);
  return { blocks, stableCount, stableEnd };
}

/**
 * A bounded, render-local memoizer. Only the unfinished suffix is parsed again;
 * closed paragraphs, list items and fences keep their object identity. A rewind
 * or replacement safely resets the cache (including discarded React renders).
 */
export function createMarkdownParser(trackSource = false) {
  let previousText = '';
  let previousStreaming = true;
  let previous: readonly MarkdownBlock[] = [];
  let stable: readonly MarkdownBlock[] = [];
  let stableEnd = 0;
  return (text: string, streaming = false): readonly MarkdownBlock[] => {
    if (text === previousText && streaming === previousStreaming) return previous;
    if (!previousStreaming || !text.startsWith(previousText)) { stable = []; stableEnd = 0; }
    const tail = parseTail(text, stableEnd, streaming, trackSource);
    const next = [...stable, ...tail.blocks];
    for (let index = stable.length; index < next.length; index++) {
      if (sameBlock(previous[index], next[index])) next[index] = previous[index];
    }
    stable = next.slice(0, stable.length + tail.stableCount);
    stableEnd = tail.stableEnd;
    previousText = text;
    previousStreaming = streaming;
    previous = next;
    return next;
  };
}

function unescapedIndex(text: string, delimiter: string, start: number) {
  for (let index = text.indexOf(delimiter, start); index !== -1; index = text.indexOf(delimiter, index + 1)) {
    let escapes = 0;
    for (let previous = index - 1; previous >= 0 && text[previous] === '\\'; previous--) escapes++;
    if (escapes % 2 === 0) return index;
  }
  return -1;
}

/** Optimistic inline formatting keeps delimiters/unfinished URLs out of live text. */
export function parseInline(text: string, streaming = false, trackSource = false): readonly InlineToken[] {
  const tokens: InlineToken[] = [];
  let plain = '';
  let plainStart = 0;
  let plainSpans: SourceSpan[] = [];
  const flush = () => {
    if (plain) tokens.push({ key: plainStart, kind: 'text', text: plain, ...(trackSource ? { sourceSpans: plainSpans } : {}) });
    plain = '';
    plainSpans = [];
  };
  const literal = (value: string, index: number, sourceIndex = index) => {
    if (!plain) plainStart = index;
    if (trackSource) {
      const last = plainSpans.at(-1);
      if (last && last.sourceStart + last.end - last.start === sourceIndex) {
        plainSpans[plainSpans.length - 1] = { ...last, end: plain.length + value.length };
      } else plainSpans.push({ start: plain.length, end: plain.length + value.length, sourceStart: sourceIndex });
    }
    plain += value;
  };
  const span = (content: string, sourceStart: number) => trackSource
    ? { sourceSpans: [{ start: 0, end: content.length, sourceStart }] } : {};
  for (let index = 0; index < text.length;) {
    if (text[index] === '\\' && /[\\`*_[\]]/.test(text[index + 1] ?? '')) {
      literal(text[index + 1], index, index + 1); index += 2; continue;
    }
    if (streaming && index === text.length - 1 && /[\\*_`]/.test(text[index])) break;
    const character = text[index];
    const delimiter = text.startsWith('**', index) ? '**' : text.startsWith('__', index) ? '__'
      : character === '`' || character === '*' || (character === '_' && !/\w/.test(text[index - 1] ?? '')) ? character : undefined;
    if (delimiter) {
      const end = unescapedIndex(text, delimiter, index + delimiter.length);
      if (end !== -1 || streaming) {
        flush();
        let content = text.slice(index + delimiter.length, end === -1 ? undefined : end);
        if (end === -1 && delimiter.length === 2 && content.endsWith(delimiter[0])) content = content.slice(0, -1);
        if (content) tokens.push({ key: index, kind: delimiter === '`' ? 'code' : delimiter.length === 2 ? 'strong' : 'emphasis', text: content, ...span(content, index + delimiter.length) });
        index = end === -1 ? text.length : end + delimiter.length;
        continue;
      }
    }
    if (character === '[') {
      const labelEnd = unescapedIndex(text, ']', index + 1);
      const label = text.slice(index + 1, labelEnd === -1 ? undefined : labelEnd);
      const hasTarget = labelEnd !== -1 && text[labelEnd + 1] === '(';
      let targetEnd = -1;
      if (hasTarget) {
        let depth = 1;
        for (let cursor = labelEnd + 2; cursor < text.length; cursor++) {
          if (text[cursor] === '(') depth++;
          if (text[cursor] === ')' && --depth === 0) { targetEnd = cursor; break; }
        }
      }
      const href = hasTarget && targetEnd !== -1 ? text.slice(labelEnd + 2, targetEnd) : undefined;
      const pending = streaming && (labelEnd === -1 || labelEnd === text.length - 1 || (hasTarget && targetEnd === -1));
      if (pending || (href && /^https?:\/\/\S+$/.test(href))) {
        flush();
        if (label) tokens.push({ key: index, kind: 'link', text: label, ...(href ? { href } : {}), ...span(label, index + 1) });
        index = pending ? text.length : targetEnd + 1;
        continue;
      }
    }
    literal(character, index);
    index++;
  }
  flush();
  return tokens;
}
