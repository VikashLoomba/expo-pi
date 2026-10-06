import type { Context, JsonValue } from '@earendil-works/chord';
import type { ToolDiagnostic, ToolExecutionResult } from '@earendil-works/pi-durable';
import type { ArtifactWriter } from '../execution/types';

export const EDIT_PRESENTATION_LIMITS = Object.freeze({
  contentBytes: 32 * 1024, previewBytes: 24 * 1024, previewLines: 200,
  inlinePatchBytes: 16 * 1024, detailsJsonBytes: 64 * 1024,
});

export type EditPresentationDetails = {
  diff: string; diffTruncated: boolean; patchBytes: number;
  patch?: string; patchPath?: string; patchUnavailable?: boolean; firstChangedLine?: number;
};

const encoder = new TextEncoder();
const size = (text: string) => encoder.encode(text).length;

/** Slice on Unicode scalar boundaries; no TextDecoder BOM behavior is involved. */
function excerpt(text: string, maximum: number, maxLines = Infinity): string {
  let bytes = 0, end = 0, lines = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    const nextBytes = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + nextBytes > maximum) break;
    bytes += nextBytes;
    end += character.length;
    if (character === '\n' && ++lines === maxLines) break;
  }
  return text.slice(0, end);
}

function preview(text: string): string {
  let maximum = EDIT_PRESENTATION_LIMITS.previewBytes;
  let result = excerpt(text, maximum, EDIT_PRESENTATION_LIMITS.previewLines);
  // JSON escapes control characters. Bound serialized details as well as visible UTF-8.
  while (size(JSON.stringify(result)) > EDIT_PRESENTATION_LIMITS.previewBytes) {
    maximum = Math.floor(maximum / 2);
    result = excerpt(text, maximum, EDIT_PRESENTATION_LIMITS.previewLines);
  }
  return result;
}

function editDetails(value: JsonValue | undefined): { diff: string; patch: string; firstChangedLine?: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    typeof value.diff !== 'string' || typeof value.patch !== 'string') return undefined;
  return { diff: value.diff, patch: value.patch,
    ...(typeof value.firstChangedLine === 'number' && Number.isSafeInteger(value.firstChangedLine) && value.firstChangedLine > 0
      ? { firstChangedLine: value.firstChangedLine } : {}) };
}

/**
 * Finalize edit results only. Read's selected content and continuation diagnostics
 * must remain untouched: clipping it here would make its next offset skip text.
 */
export async function finalizeEditResult(
  result: ToolExecutionResult,
  context: Context,
  artifacts?: ArtifactWriter,
): Promise<ToolExecutionResult> {
  const original = editDetails(result.details);
  if (!original) return result;
  context.abortSignal?.throwIfAborted();
  const diff = preview(original.diff);
  const details: EditPresentationDetails = {
    diff, diffTruncated: diff !== original.diff, patchBytes: size(original.patch),
    ...(original.firstChangedLine === undefined ? {} : { firstChangedLine: original.firstChangedLine }),
  };
  const diagnostics: ToolDiagnostic[] = [...(result.diagnostics ?? [])];
  if (details.patchBytes <= EDIT_PRESENTATION_LIMITS.inlinePatchBytes &&
    size(JSON.stringify(original.patch)) <= EDIT_PRESENTATION_LIMITS.inlinePatchBytes) {
    details.patch = original.patch;
  } else {
    try {
      if (!artifacts) throw new Error('This environment has no persistent artifact writer.');
      details.patchPath = await artifacts.write('edit-patch', original.patch, context);
      diagnostics.push({ severity: 'info', code: 'edit_patch_saved', message: `Full edit patch: ${details.patchPath}` });
    } catch (cause) {
      context.abortSignal?.throwIfAborted();
      details.patchUnavailable = true;
      const message = excerpt(cause instanceof Error ? cause.message : String(cause), 1024);
      diagnostics.push({ severity: 'warn', code: 'edit_patch_unavailable',
        message: `The edit succeeded, but the full patch could not be saved: ${message}` });
    }
  }
  if (details.diffTruncated) diagnostics.push({ severity: 'info', code: 'edit_preview_truncated',
    message: 'The displayed edit diff is a bounded preview. The full patch is included or saved separately when available.' });
  let remaining = EDIT_PRESENTATION_LIMITS.contentBytes;
  const content = result.content?.map((part) => {
    if (part.type !== 'text') return part;
    const text = excerpt(part.text, remaining);
    remaining -= size(text);
    if (text !== part.text) diagnostics.push({ severity: 'warn', code: 'edit_summary_truncated', message: 'The edit summary was truncated.' });
    return { ...part, text };
  });
  // Fields are intentionally selected above; unbounded SDK details never cross
  // this boundary. The two string budgets leave ample room for fixed metadata.
  return { ...result, ...(content === undefined ? {} : { content }), details, diagnostics };
}
