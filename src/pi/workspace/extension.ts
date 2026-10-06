import { defineExtension, section } from '@earendil-works/pi-durable';
import { createBashTool } from '../bash/tool';
import { scopeTool } from '../execution/tool-scope';
import type { SharedToolPolicy } from '../execution/types';
import { WORKSPACE_EXTENSION } from './document';
import { createWorkspaceFileTools } from './file-tools';

export function createWorkspaceExtension(policy: SharedToolPolicy) {
  const files = createWorkspaceFileTools(policy);
  const tools = [createBashTool(policy), ...files.tools];
  return defineExtension({
    // The historical name is a persisted selection, independent of the selected environment.
    name: WORKSPACE_EXTENSION,
    sections: [section('local_workspace', async (input, context) => [
      ...(await policy.promptFacts(input, context)),
      input.env ? `Current execution directory: ${input.env.cwd}` : 'No execution environment is configured.',
      'Use read for paged text (positive 1-based offset and limit), write for full UTF-8 replacement, and edit for targeted changes. Images are not supported by read. Binary reads may show replacement characters; edit requires valid UTF-8.',
      'All edits in one edit call match the original file. Supply enough unique surrounding text; split expensive changes into smaller calls or use write for a complete replacement.',
      'Tool output and edit previews are bounded. Full artifacts are saved only when this environment supplies persistent artifact storage; otherwise the result explains their unavailability.',
      'Interrupted bash, write and edit calls may have changed files. Inspect with read or bash before retrying a mutation.',
    ].join('\n'))],
    tools,
    // The outer scope includes edit admission, SDK read/match/write and final presentation.
    wraps: [...files.wraps, ...tools.map((tool) => scopeTool(tool, policy))],
  });
}
