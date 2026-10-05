/** Small, validated UI state derived from tool arguments and durable result details. */
export type FileToolPresentation = {
  kind: 'read' | 'write' | 'edit';
  path: string;
  summary: string;
  diff?: string;
  diffTruncated?: boolean;
  firstChangedLine?: number;
  patchPath?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function fileToolPresentation(name: string, args: unknown): FileToolPresentation | undefined {
  if (name !== 'read' && name !== 'write' && name !== 'edit') return;
  const input = record(args);
  if (!input || typeof input.path !== 'string' || !input.path || input.path.length > 4096) return;
  let summary: string;
  if (name === 'read') {
    if ((input.offset !== undefined && !positiveInteger(input.offset)) ||
        (input.limit !== undefined && !positiveInteger(input.limit))) return;
    const offset = input.offset ?? 1;
    summary = input.limit === undefined ? `From line ${offset}` : `${input.limit} line${input.limit === 1 ? '' : 's'} from line ${offset}`;
  } else if (name === 'write') {
    if (typeof input.content !== 'string') return;
    summary = `${new TextEncoder().encode(input.content).length.toLocaleString()} UTF-8 bytes`;
  } else {
    // Pi also accepts legacy top-level and object/string edits through prepareArguments.
    // Mixed legacy + array forms are repaired by Pi; keep their original input visible.
    if (input.edits !== undefined && (input.oldText !== undefined || input.newText !== undefined)) return;
    let edits = input.edits;
    if (typeof edits === 'string' && edits.length <= 1024 * 1024) {
      try { edits = JSON.parse(edits); } catch { return; }
    }
    const replacements = Array.isArray(edits) ? edits : record(edits) ? [edits] : [input];
    if (!replacements.length || !replacements.every((replacement) => {
      const value = record(replacement);
      return typeof value?.oldText === 'string' && typeof value.newText === 'string';
    })) return;
    const count = replacements.length;
    summary = `${count} replacement${count === 1 ? '' : 's'}`;
  }
  return { kind: name, path: input.path, summary };
}

/** Never trust old stored details to satisfy the current production output policy. */
export function withFileToolDetails(presentation: FileToolPresentation | undefined, details: unknown): FileToolPresentation | undefined {
  if (!presentation || presentation.kind !== 'edit') return presentation;
  const value = record(details);
  if (!value) return presentation;
  const diff = typeof value.diff === 'string' ? value.diff : undefined;
  const maxUnits = 24 * 1024;
  let preview = diff?.slice(0, maxUnits);
  // A historical diff can exceed today's byte bound; don't end its preview inside a surrogate pair.
  if (preview && /[\uD800-\uDBFF]$/.test(preview)) preview = preview.slice(0, -1);
  return { ...presentation,
    ...(preview !== undefined ? { diff: preview, diffTruncated: diff!.length > preview.length || value.diffTruncated === true } : {}),
    ...(positiveInteger(value.firstChangedLine) ? { firstChangedLine: value.firstChangedLine } : {}),
    ...(typeof value.patchPath === 'string' && value.patchPath.startsWith('/workspace/') && value.patchPath.length <= 4096
      ? { patchPath: value.patchPath } : {}),
  };
}
