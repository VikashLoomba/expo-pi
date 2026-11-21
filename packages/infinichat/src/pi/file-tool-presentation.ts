import { createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';
import { compile, int, obj, opt, str } from '@earendil-works/pi-schema';

import type { FileToolPresentation } from '../chat/file-tool-presentation';

const edit = createEditTool();
const readArguments = compile(createReadTool().parameters);
const writeArguments = compile(createWriteTool().parameters);
const editArguments = compile(edit.parameters);
/** The edit tool's details as the card shows them; other stored details, such as the patch, stay out. */
const editDetails = compile(obj({ diff: str(), firstChangedLine: opt(int({ minimum: 1 })) }, { open: true }));
/** `read`'s details for an image the conversation's model could not take (pi-durable's `ReadToolDetails`). */
const unseenImage = compile(obj({ imageUnsupportedByModel: str() }, { open: true }));
/** A line the card can name. */
const line = compile(int({ minimum: 1 }));
const lines = (value: number | undefined) => value === undefined || line.check(value);

/** A file tool's card, from the arguments as its own tool checks them, after pi repairs an edit's (`edit.ts`). */
export function fileToolPresentation(name: string, args: unknown): FileToolPresentation | undefined {
  if (name === 'read') {
    if (!readArguments.check(args) || !args.path || !lines(args.offset) || !lines(args.limit)) return;
    const offset = args.offset ?? 1;
    const summary = args.limit === undefined
      ? `From line ${offset}`
      : `${args.limit} line${args.limit === 1 ? '' : 's'} from line ${offset}`;
    return { kind: name, path: args.path, summary };
  }
  if (name === 'write') {
    if (!writeArguments.check(args) || !args.path) return;
    return { kind: name, path: args.path,
      summary: `${new TextEncoder().encode(args.content).length.toLocaleString()} UTF-8 bytes` };
  }
  if (name !== 'edit') return;
  // The legacy shapes models send, a top-level pair or `edits` as a string or one object, are what pi runs.
  const prepared = edit.prepareArguments?.(args) ?? args;
  if (!editArguments.check(prepared) || !prepared.path || prepared.edits.length === 0) return;
  const count = prepared.edits.length;
  return { kind: name, path: prepared.path, summary: `${count} replacement${count === 1 ? '' : 's'}` };
}

/**
 * What a `read` of an image adds to its output on screen when the model then had no image input. pi-durable keeps it
 * out of the stored result, which a model that takes images may read later, and names the model in the result's
 * details for UIs to say so.
 */
export function unseenImageNote(name: string, details: unknown): string | undefined {
  if (name !== 'read' || !unseenImage.check(details)) return undefined;
  return `${details.imageUnsupportedByModel} takes no images, so it was shown a placeholder in place of this one.`;
}

/** The edit card shows pi's own diff and where it starts. */
export function withFileToolDetails(presentation: FileToolPresentation | undefined,
  details: unknown): FileToolPresentation | undefined {
  if (!presentation || presentation.kind !== 'edit' || !editDetails.check(details)) return presentation;
  return { ...presentation, diff: details.diff,
    ...(details.firstChangedLine === undefined ? {} : { firstChangedLine: details.firstChangedLine }) };
}
