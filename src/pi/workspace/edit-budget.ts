import type { Context } from '@earendil-works/chord';
import { withoutAbortSignal } from '@earendil-works/chord/context';
import { FileError, err, ok, type ExecutionEnv, type Result } from '@earendil-works/pi-durable/env';
import { diffLines, type Change } from 'diff';
import { CooperativeWork, textChunkEnd } from './cooperative-work';
import { DelegatingExecutionEnv } from '../execution/delegating-env';

export type EditReplacement = { oldText: string; newText: string };
export type EditBudget = {
  maxEdits: number; maxInputBytes: number; maxFileBytes: number; maxLines: number;
  maxNormalizedUnits: number; maxMatchUnits: number; maxMatchLines: number;
  maxNormalizationExpansionUnits: number; maxCombiningRun: number; maxCombiningWork: number;
  maxOccurrenceSlots: number; maxSearchComparisons: number; maxDiffDistance: number; maxDiffUnits: number;
  maxDiffLineWork: number; maxDetailsBytes: number; preflightTimeoutMs: number;
};

/** Work ceilings, separate from storage limits. Native Hermes probes must validate these ceilings. */
export const EDIT_BUDGET: Readonly<EditBudget> = Object.freeze({
  maxEdits: 32, maxInputBytes: 1024 * 1024, maxFileBytes: 8 * 1024 * 1024,
  maxLines: 131_072, maxNormalizedUnits: 8 * 1024 * 1024,
  maxNormalizationExpansionUnits: 1024 * 1024, maxCombiningRun: 64,
  maxCombiningWork: 32 * 1024 * 1024,
  maxMatchUnits: 32 * 1024 * 1024, maxMatchLines: 1_048_576,
  maxOccurrenceSlots: 65_536, maxSearchComparisons: 512 * 1024 * 1024, maxDiffDistance: 128,
  maxDiffUnits: 128 * 1024 * 1024, maxDiffLineWork: 4 * 1024 * 1024,
  maxDetailsBytes: 8 * 1024 * 1024, preflightTimeoutMs: 250,
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SOURCE_CHUNK_BYTES = 64 * 1024;
const normalizeLF = (text: string) => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
const recovery = 'Use smaller targeted edits, or use write to replace the complete file.';

/** Policy errors deliberately throw: Pi otherwise hides FileError messages behind an error code. */
export class EditBudgetError extends Error {
  constructor(message: string) { super(message); this.name = 'EditBudgetError'; }
}

function reject(message: string): never { throw new EditBudgetError(`${message} ${recovery}`); }

function byteLength(text: string) { return encoder.encode(text).length; }

/** Keep only an unfinished UTF-8 scalar for the next bounded read. Invalid bytes stay for validation. */
function utf8ChunkEnd(bytes: Uint8Array): number {
  let start = bytes.length - 1;
  while (start > 0 && bytes.length - start < 4 && (bytes[start] & 0xc0) === 0x80) start--;
  const lead = bytes[start];
  const width = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3
    : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  return width > bytes.length - start ? start : bytes.length;
}

/** Round-trip validation works on Hermes without relying on TextDecoder's fatal/stream options. */
function strictTextChunk(bytes: Uint8Array): string | undefined {
  let prefix = 0;
  // Default decoders remove a leading BOM. Preserve every mark, including at a chunk boundary.
  while (bytes[prefix] === 0xef && bytes[prefix + 1] === 0xbb && bytes[prefix + 2] === 0xbf) prefix += 3;
  const body = bytes.subarray(prefix);
  const text = decoder.decode(body);
  const encoded = encoder.encode(text);
  if (encoded.length !== body.length || encoded.some((byte, index) => byte !== body[index])) return undefined;
  return '\ufeff'.repeat(prefix / 3) + text;
}

async function scannedByteLength(text: string, work: CooperativeWork): Promise<number> {
  let bytes = 0;
  for (let start = 0; start < text.length;) {
    const end = textChunkEnd(text, start);
    bytes += byteLength(text.slice(start, end));
    start = end;
    await work.checkpoint();
  }
  return bytes;
}

/** Same line-token count as the default public diffLines tokenizer, without allocating an array. */
async function lineCount(text: string, work: CooperativeWork): Promise<number> {
  let lines = text.length && !text.endsWith('\n') ? 1 : 0;
  for (let start = 0; start < text.length; start += 65_536) {
    const end = Math.min(text.length, start + 65_536);
    for (let at = start; at < end; at++) if (text.charCodeAt(at) === 10) lines++;
    await work.checkpoint();
  }
  return lines;
}

type ScalarWork = {
  units: number; expansion: number; combiningWork: number;
  leadingMarks: number; trailingMarks: number; longestRun: number; onlyMarks: boolean;
};
type NormalizationWork = { units: number; expansion: number; combiningWork: number };
type NormalizationLimits = { maxUnits: number; maxExpansion: number; maxCombiningWork: number; maxRun: number };
const isMark = /\p{M}/u;

function scalarWork(point: number): ScalarWork {
  const scalar = String.fromCodePoint(point);
  const decomposed = scalar.normalize('NFKD');
  let leadingMarks = 0, trailingMarks = 0, longestRun = 0, combiningWork = 0, onlyMarks = true;
  for (const character of decomposed) {
    if (isMark.test(character)) {
      combiningWork += 2 * trailingMarks * character.length + character.length ** 2;
      trailingMarks += character.length;
      if (onlyMarks) leadingMarks += character.length;
      longestRun = Math.max(longestRun, trailingMarks);
    } else {
      onlyMarks = false;
      trailingMarks = 0;
    }
  }
  return { units: decomposed.length, expansion: Math.max(0, scalar.normalize('NFKC').length - scalar.length),
    combiningWork, leadingMarks, trailingMarks, longestRun, onlyMarks };
}

/**
 * Inspect scalars before normalizing a whole string. Decomposition lengths add;
 * later composition only reduces them. Decomposed Mark runs bound canonical
 * ordering, including compatibility letters which become marks (e.g. U+FF9E).
 * Scalar NFKC growth is a separate conservative work policy, not an exact bound
 * on whole-string growth; canonical interactions also obey the units/run limits.
 * Summed squared run lengths additionally bound accumulated reordering work,
 * so many legal short runs cannot evade the individual run-length ceiling.
 */
async function normalizationWork(
  text: string, limits: NormalizationLimits,
  cache: Map<number, ScalarWork>, work: CooperativeWork,
): Promise<NormalizationWork> {
  let units = 0, expansion = 0, combiningWork = 0, marks = 0;
  for (let start = 0; start < text.length;) {
    const end = textChunkEnd(text, start, 1024);
    for (let at = start; at < end;) {
      const point = text.codePointAt(at)!;
      if (point <= 0x7f) {
        units++;
        marks = 0;
        at++;
        continue;
      }
      let scalar = cache.get(point);
      if (!scalar) {
        scalar = scalarWork(point);
        // Cache belongs to this invocation; diverse text cannot grow it without limit.
        if (cache.size < 4096) cache.set(point, scalar);
      }
      units += scalar.units;
      expansion += scalar.expansion;
      // Merging adjacent runs adds (a+b)^2-a^2-b^2 = 2ab. This carries
      // the exact sum of squared decomposed Mark runs across every boundary.
      combiningWork += scalar.combiningWork + 2 * marks * scalar.leadingMarks;
      if (Math.max(marks + scalar.leadingMarks, scalar.longestRun) > limits.maxRun) {
        reject('This edit exceeds the Unicode combining-mark run budget.');
      }
      marks = scalar.onlyMarks ? marks + scalar.units : scalar.trailingMarks;
      if (combiningWork > limits.maxCombiningWork) reject('This edit exceeds the aggregate Unicode combining work budget.');
      if (expansion > limits.maxExpansion) reject('This edit exceeds the Unicode normalization expansion work budget.');
      at += point > 0xffff ? 2 : 1;
    }
    if (units > limits.maxUnits) reject('This file exceeds the edit normalization work budget.');
    start = end;
    await work.checkpoint();
  }
  return { units, expansion, combiningWork };
}

/** The pinned Pi 1.0 fuzzy normalizer's one-unit punctuation/space substitutions. */
function foldedUnit(unit: number): number {
  if (unit >= 0x2018 && unit <= 0x201b) return 39;
  if (unit >= 0x201c && unit <= 0x201f) return 34;
  if ((unit >= 0x2010 && unit <= 0x2015) || unit === 0x2212) return 45;
  if (unit === 0xa0 || (unit >= 0x2002 && unit <= 0x200a) ||
    unit === 0x202f || unit === 0x205f || unit === 0x3000) return 32;
  return unit;
}

async function frequencies(text: string, work: CooperativeWork, fold = false): Promise<Uint32Array> {
  const counts = new Uint32Array(65_536);
  for (let start = 0; start < text.length; start += 65_536) {
    const end = Math.min(text.length, start + 65_536);
    for (let at = start; at < end; at++) {
      const unit = text.charCodeAt(at);
      counts[fold ? foldedUnit(unit) : unit]++;
    }
    await work.checkpoint();
  }
  return counts;
}

type PatternWork = { rawFirst?: number; rawUnits: number; fuzzyFirst?: number; fuzzyUnits: number; minimumUnits: number };

async function patternWork(raw: string, work: CooperativeWork): Promise<PatternWork> {
  const normalized = raw.normalize('NFKC');
  await work.checkpoint();
  const newline = normalized.indexOf('\n');
  const firstLine = normalized.slice(0, newline < 0 ? normalized.length : newline).trimEnd();
  // Trimming a whitespace-only first line exposes its LF, not the next line's
  // first letter. An entirely whitespace-only pattern becomes empty.
  const first = firstLine.length ? firstLine.charCodeAt(0) : newline >= 0 ? 10 : undefined;
  let minimumUnits = 0;
  for (let start = 0; start < normalized.length;) {
    const end = textChunkEnd(normalized, start, 8192);
    minimumUnits += normalized.slice(start, end).replace(/\s/gu, '').length;
    start = end;
    await work.checkpoint();
  }
  return {
    rawFirst: raw.length ? raw.charCodeAt(0) : undefined, rawUnits: raw.length,
    fuzzyFirst: first === undefined ? undefined : foldedUnit(first), fuzzyUnits: normalized.length,
    minimumUnits,
  };
}

/**
 * Hermes searches may use a naive O(N*K) algorithm. Only positions matching the
 * first UTF-16 unit can compare the rest of K, so N + frequency(first)*K bounds
 * one complete search. Split's non-overlapping searches advance through N once.
 * Pi makes at most two exact searches and three fuzzy searches for each edit.
 */
async function admitSearchWork(source: string, patterns: readonly PatternWork[], budget: Readonly<EditBudget>, work: CooperativeWork): Promise<void> {
  const raw = await frequencies(source, work);
  // Called only after the scalar NFKD allocation budget has passed. NFKD counts
  // alone are unsuitable here: e + combining acute can compose into a new é.
  const normalized = source.normalize('NFKC');
  await work.checkpoint();
  const fuzzy = await frequencies(normalized, work, true);
  // Omitting trimEnd from the histogram only overcounts possible start positions.
  const exactUnits = Math.max(source.length, normalized.length);
  let comparisons = 0;
  for (const pattern of patterns) {
    const exactStarts = pattern.rawFirst === undefined ? 0 : Math.max(raw[pattern.rawFirst], fuzzy[pattern.rawFirst]);
    const fuzzyStarts = pattern.fuzzyFirst === undefined ? 0 : fuzzy[pattern.fuzzyFirst];
    comparisons += 2 * (exactUnits + exactStarts * pattern.rawUnits)
      + 3 * (normalized.length + fuzzyStarts * pattern.fuzzyUnits);
    if (comparisons > budget.maxSearchComparisons) {
      reject('This edit exceeds the text-search work budget. Choose more distinctive surrounding text or split the operation.');
    }
  }
}

function contextEdge(text: string, tail: boolean): string {
  if (!tail) {
    let end = 0;
    for (let lines = 0; lines < 4; lines++) {
      const newline = text.indexOf('\n', end);
      if (newline < 0) return text;
      end = newline + 1;
    }
    return text.slice(0, end);
  }
  let start = text.endsWith('\n') ? text.length - 1 : text.length;
  for (let lines = 0; lines < 4; lines++) {
    const newline = text.lastIndexOf('\n', start - 1);
    if (newline < 0) return text;
    start = newline;
  }
  return text.slice(start + 1);
}

/** Conservative materialization bound for both SDK representations, including line prefixes. */
async function detailsUpperBound(changes: readonly Change[], path: string, work: CooperativeWork): Promise<number> {
  let bytes = 0, lines = 0;
  for (const part of changes) {
    if (part.added || part.removed) {
      bytes += await scannedByteLength(part.value, work);
      lines += part.count;
    } else {
      // Double-count overlapping short context edges: an upper bound is intentional.
      bytes += await scannedByteLength(contextEdge(part.value, false), work)
        + await scannedByteLength(contextEdge(part.value, true), work);
      lines += Math.min(part.count, 4) * 2;
    }
  }
  return bytes * 2 + lines * 24 + changes.length * 256 + byteLength(path) * 2 + 2048;
}

type Source = { path: string; before: string; hadBom: boolean; lines: number };

/** Pi's edit factory remains responsible for matching; this class only admits bounded work. */
export class EditExecutionEnv extends DelegatingExecutionEnv {
  private source?: Source;

  constructor(
    environment: ExecutionEnv,
    private readonly edits: readonly EditReplacement[],
    private readonly budget: Readonly<EditBudget> = EDIT_BUDGET,
  ) {
    super(environment);
    if (edits.length === 0 || edits.length > budget.maxEdits) {
      reject(`An edit call must contain between 1 and ${budget.maxEdits} replacements.`);
    }
    let bytes = 0;
    for (const { oldText, newText } of edits) {
      if (oldText.length + newText.length > budget.maxInputBytes) reject('The edit arguments exceed the input budget.');
      bytes += byteLength(oldText) + byteLength(newText);
      if (bytes > budget.maxInputBytes) reject('The edit arguments exceed the input budget.');
    }
  }

  private closed = false;

  private active(context: Context, path?: string): void {
    context.abortSignal?.throwIfAborted();
    if (this.closed) throw new FileError('aborted', 'Edit policy is closed.', path);
  }

  // The scope owns backend cleanup. Closing this policy never kills another consumer.
  override async cleanup(_context: Context): Promise<void> { this.closed = true; }

  private work(context: Context, path: string): CooperativeWork {
    return new CooperativeWork(() => this.active(context, path));
  }

  /** Read the opened file itself, never a whole-file backend text method or a second pathname lookup. */
  private async readSource(path: string, context: Context, work: CooperativeWork): Promise<Result<{ text: string; bytes: number }, FileError>> {
    const opened = await this.environment.openBinaryReader(path, undefined, context);
    if (!opened.ok) { this.active(context, path); return opened; }
    try {
      this.active(context, path);
      const info = await opened.value.info(context);
      this.active(context, path);
      if (!info.ok) return info;
      if (info.value.size > this.budget.maxFileBytes) reject('This file exceeds the edit file-size limit.');
      const chunks: string[] = [];
      let bytes = 0;
      let pending = new Uint8Array();
      while (true) {
        await work.checkpoint();
        // The single extra byte detects growth past the ceiling without receiving the enlarged file.
        const length = Math.min(SOURCE_CHUNK_BYTES, this.budget.maxFileBytes - bytes + 1);
        const part = await opened.value.read(bytes, length, context);
        this.active(context, path);
        if (!part.ok) return part;
        if (part.value.length > length) return err(new FileError('invalid', 'Binary reader exceeded its requested byte range.', path));
        bytes += part.value.length;
        if (bytes > this.budget.maxFileBytes) reject('This file exceeds the edit file-size limit.');
        const complete = part.value.length < length;
        const joined = new Uint8Array(pending.length + part.value.length);
        joined.set(pending);
        joined.set(part.value, pending.length);
        const end = complete ? joined.length : utf8ChunkEnd(joined);
        const text = strictTextChunk(joined.subarray(0, end));
        if (text === undefined) return err(new FileError('invalid', 'File is not valid UTF-8 text.', path));
        chunks.push(text);
        pending = joined.slice(end);
        if (complete) return ok({ text: chunks.join(''), bytes });
      }
    } finally {
      await opened.value.close(withoutAbortSignal(context));
    }
  }

  override async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const work = this.work(context, path);
    const cache = new Map<number, ScalarWork>();
    const rawPatterns: string[] = [];
    let patternUnits = 0, patternExpansion = 0, patternCombiningWork = 0;
    // Constructor work is limited to argument size/count. Every full-string
    // normalization waits for all scalar allocation, expansion and run checks.
    for (const { oldText } of this.edits) {
      const raw = normalizeLF(oldText);
      const measured = await normalizationWork(raw, {
        maxUnits: this.budget.maxNormalizedUnits - patternUnits,
        maxExpansion: this.budget.maxNormalizationExpansionUnits - patternExpansion,
        maxCombiningWork: this.budget.maxCombiningWork - patternCombiningWork,
        maxRun: this.budget.maxCombiningRun,
      }, cache, work);
      patternUnits += measured.units;
      patternExpansion += measured.expansion;
      patternCombiningWork += measured.combiningWork;
      rawPatterns.push(raw);
    }
    this.active(context, path);
    const result = await this.readSource(path, context, work);
    this.active(context, path);
    if (!result.ok) return result;
    if (this.source) reject('One edit invocation can read only one original file.');
    const { text, bytes: fileBytes } = result.value;
    // Repeated SDK normalization also costs work on multibyte text whose UTF-16
    // length is much smaller than its UTF-8 size. Charge the larger quantity.
    if (fileBytes * this.edits.length > this.budget.maxMatchUnits) {
      reject('This edit exceeds the normalization and matching work budget.');
    }
    const hadBom = text.startsWith('\ufeff');
    const before = normalizeLF(hadBom ? text.slice(1) : text);
    const lines = await lineCount(before, work);
    if (lines > this.budget.maxLines || lines * this.edits.length > this.budget.maxMatchLines) {
      reject('This edit exceeds the line-processing work budget.');
    }
    const { units } = await normalizationWork(before, {
      maxUnits: Math.min(this.budget.maxNormalizedUnits, Math.floor(this.budget.maxMatchUnits / this.edits.length)),
      maxExpansion: Math.floor((this.budget.maxNormalizationExpansionUnits - patternExpansion) / this.edits.length),
      maxCombiningWork: Math.floor((this.budget.maxCombiningWork - patternCombiningWork) / this.edits.length),
      maxRun: this.budget.maxCombiningRun,
    }, cache, work);
    const patterns: PatternWork[] = [];
    // Removing all whitespace gives a lower bound on Pi's fuzzy pattern length,
    // sufficient to bound split() allocations without implementing its matcher.
    for (const raw of rawPatterns) patterns.push(await patternWork(raw, work));
    for (const { minimumUnits: minimum } of patterns) {
      if (Math.floor(units / Math.max(1, minimum)) + 1 > this.budget.maxOccurrenceSlots) {
        reject('This edit needs more surrounding text to keep matching bounded. Include a larger unique oldText block.');
      }
    }
    await admitSearchWork(before, patterns, this.budget, work);
    await work.yield();
    this.source = { path, before, hadBom, lines };
    return ok(text);
  }

  override async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const source = this.source;
    if (!source || source.path !== path || typeof content !== 'string') {
      reject('An edit must write text to the same file it read.');
    }
    const work = this.work(context, path);
    if (content.length > this.budget.maxFileBytes || await scannedByteLength(content, work) > this.budget.maxFileBytes) {
      reject('The edited file would exceed the edit file-size limit.');
    }
    if (source.hadBom && !content.startsWith('\ufeff')) reject('The edit implementation did not preserve the original BOM.');
    // Remove exactly the BOM Pi restored. A BOM inserted by newText must remain,
    // including when an original BOM makes the proposed file start with two BOMs.
    const after = normalizeLF(source.hadBom ? content.slice(1) : content);
    const lines = await lineCount(after, work);
    if (lines > this.budget.maxLines) reject('The edited file exceeds the line-processing work budget.');
    const maxEditLength = Math.min(this.budget.maxDiffDistance,
      Math.floor(this.budget.maxDiffUnits / Math.max(1, source.before.length + after.length)) - 1,
      Math.floor(this.budget.maxDiffLineWork / Math.max(1, source.lines + lines)) - 1);
    if (maxEditLength < 1) reject('This edit exceeds the diff work budget.');
    await work.yield();
    // These are the exact two strings Pi will diff after writeFile resolves. Keep
    // all comparison options at their defaults. A successful bounded preflight
    // bounds the edit distance of both subsequent SDK diff calculations.
    const changes = diffLines(source.before, after, { maxEditLength, timeout: this.budget.preflightTimeoutMs });
    if (!changes) reject('This edit changes too many lines or exceeds the diff work budget.');
    if (await detailsUpperBound(changes, path, work) > this.budget.maxDetailsBytes) {
      reject('This edit would produce an excessively large diff, possibly from a very long line.');
    }
    await work.yield();
    const result = await super.writeFile(path, content, context);
    if (result.ok) this.source = undefined;
    return result;
  }
}
