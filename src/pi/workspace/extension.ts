import { defineExtension, section } from '@earendil-works/pi-durable';

import type { SharedToolPolicy } from '../execution/types';
import { WORKSPACE_EXTENSION } from './document';
import { createWorkspaceTools } from './tools';

export function createWorkspaceExtension(policy: SharedToolPolicy) {
  const { tools, wraps } = createWorkspaceTools();
  return defineExtension({
    // The historical name is a persisted selection, independent of the selected environment.
    name: WORKSPACE_EXTENSION,
    sections: [section('local_workspace', async (input, context) => [
      ...(await policy.promptFacts(input, context)),
      input.env ? `Current execution directory: ${input.env.cwd}` : 'No execution environment is configured.',
      'Use read for paged text, write for complete UTF-8 replacement, and edit for targeted changes. ' +
        'Images are not supported by read. edit requires valid UTF-8.',
      'All edits in one edit call match the original file. Supply enough unique surrounding text for each change.',
      'Tool output is bounded and keeps its end. Interrupted bash, write and edit calls may have changed files; ' +
        'inspect with read or bash before retrying a mutation.',
    ].join('\n'))],
    tools,
    wraps,
  });
}
