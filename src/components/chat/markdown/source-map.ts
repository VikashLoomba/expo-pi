import type { MappedText, SourceSpan } from './types';

/** Map a visible UTF-16 range back to the source, including decoded entities. */
export function sourceRange(spans: readonly SourceSpan[], start: number, end: number): { start: number; end: number } | undefined {
  if (start < 0 || end <= start) return undefined;
  let first: number | undefined;
  let last: number | undefined;
  let covered = start;
  for (const span of spans) {
    if (span.end <= start || span.start >= end) continue;
    const from = Math.max(start, span.start);
    const to = Math.min(end, span.end);
    if (from > covered) return undefined;
    first ??= span.sourceEnd === undefined ? span.sourceStart + from - span.start : span.sourceStart;
    last = span.sourceEnd ?? span.sourceStart + to - span.start;
    covered = Math.max(covered, to);
  }
  return first !== undefined && last !== undefined && covered >= end ? { start: first, end: last } : undefined;
}

export function literalText(text: string, sourceStart: number, sourceEnd = sourceStart + text.length): MappedText {
  return { text, sourceSpans: text ? [{ start: 0, end: text.length, sourceStart,
    ...(sourceEnd - sourceStart === text.length ? {} : { sourceEnd }) }] : [] };
}

export function joinMappedText(parts: readonly MappedText[]): MappedText {
  let text = '';
  const sourceSpans: SourceSpan[] = [];
  for (const part of parts) {
    for (const span of part.sourceSpans) {
      const next = { ...span, start: span.start + text.length, end: span.end + text.length };
      const previous = sourceSpans.at(-1);
      if (previous && previous.sourceEnd === undefined && next.sourceEnd === undefined
        && previous.end === next.start && previous.sourceStart + previous.end - previous.start === next.sourceStart) {
        sourceSpans[sourceSpans.length - 1] = { ...previous, end: next.end };
      } else sourceSpans.push(next);
    }
    text += part.text;
  }
  return { text, sourceSpans };
}

/** Slice display text while retaining absolute source offsets. */
export function sliceMappedText(value: MappedText, start: number, end: number): MappedText {
  return { text: value.text.slice(start, end), sourceSpans: value.sourceSpans.flatMap((span) => {
    const from = Math.max(start, span.start);
    const to = Math.min(end, span.end);
    return to > from ? [{ ...span, start: from - start, end: to - start,
      sourceStart: span.sourceEnd === undefined ? span.sourceStart + from - span.start : span.sourceStart }] : [];
  }) };
}

/** A transform can contract text, e.g. CRLF to space, without moving citations. */
export function replaceMappedText(value: MappedText, expression: RegExp, replacement: (text: string) => string): MappedText {
  const pieces: MappedText[] = [];
  let cursor = 0;
  for (const match of value.text.matchAll(expression)) {
    pieces.push(sliceMappedText(value, cursor, match.index));
    const range = sourceRange(value.sourceSpans, match.index, match.index + match[0].length);
    const text = replacement(match[0]);
    pieces.push(range ? literalText(text, range.start, range.end) : { text, sourceSpans: [] });
    cursor = match.index + match[0].length;
  }
  pieces.push(sliceMappedText(value, cursor, value.text.length));
  return joinMappedText(pieces);
}
