import type { JsonValue } from '@earendil-works/chord';
import { defineTool, wrapTool, type ToolRegistration } from '@earendil-works/pi-durable';
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools';

/** The edit card shows at most this much of the diff, and the transcript stores no more. */
export const EDIT_DIFF_UNITS = 16 * 1024;

const read = createReadTool();
const write = createWriteTool();
const edit: ToolRegistration<ReturnType<typeof createEditTool>['parameters']> = createEditTool();
const bash = createBashTool();

/** What an edit card shows: a bounded diff and where it starts. Pi's full patch is not kept. */
function editCardDetails(details: JsonValue | undefined): JsonValue | undefined {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return details;
  const diff = details.diff;
  const firstChangedLine = details.firstChangedLine;
  if (typeof diff !== 'string') return details;
  let shown = diff;
  if (diff.length > EDIT_DIFF_UNITS) {
    const lineEnd = diff.lastIndexOf('\n', EDIT_DIFF_UNITS);
    shown = diff.slice(0, lineEnd > 0 ? lineEnd : EDIT_DIFF_UNITS);
    // Never end inside a surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(shown)) shown = shown.slice(0, -1);
  }
  return {
    diff: shown,
    diffTruncated: shown !== diff,
    ...(typeof firstChangedLine === 'number' ? { firstChangedLine } : {}),
  };
}

/** Keep only a bounded diff of Pi's edit details in the transcript. */
const boundedEditDetails = wrapTool(edit, (tool) => ({
  ...tool,
  async execute(args, api, context) {
    const result = await tool.execute(args, api, context);
    const details = editCardDetails(result.details);
    return details === undefined ? result : { ...result, details };
  },
}));

/** Pi's own coding tools. Each runs its round one call at a time, so a chat's tools never interleave in its workspace. */
export function createWorkspaceTools() {
  const tools = [
    defineTool({ ...read, replay: 'safe', executionMode: 'sequential' }),
    defineTool({ ...write, replay: 'unsafe', executionMode: 'sequential' }),
    defineTool({ ...edit, replay: 'unsafe', executionMode: 'sequential' }),
    defineTool({ ...bash, replay: 'unsafe', executionMode: 'sequential' }),
  ];
  return { tools, wraps: [boundedEditDetails] };
}
