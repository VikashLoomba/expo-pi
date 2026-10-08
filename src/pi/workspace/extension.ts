import { defineExtension, section } from '@earendil-works/pi-durable';

import { BASH_CAPABILITY_DESCRIPTION } from '../bash/engine/index';
import { WORKSPACE_EXTENSION } from './document';
import { WorkspaceExecutionEnv } from './execution-env';

/** The prompt for pi's `CodingTools`, which are installed beside it, and for the chat's own workspace. */
export const WorkspaceExtension = defineExtension({
  // The historical name is a persisted selection, independent of the selected environment.
  name: WORKSPACE_EXTENSION,
  sections: [
    // Renders only when the chat runs in its workspace on this device; other environments describe themselves.
    section('local_workspace', ({ env }) => env instanceof WorkspaceExecutionEnv ? [
      'The read, write, edit and bash tools share this chat’s own /workspace on this device. ' +
        'It persists across app restarts; HOME and the default cwd resolve there. ' +
        'File tools reach only /workspace.',
      BASH_CAPABILITY_DESCRIPTION,
    ].join('\n') : undefined),
    section('coding_tools', ({ env }) => [
      env ? `Current execution directory: ${env.cwd}` : 'No execution environment is configured.',
      'Use read for paged text, write for complete UTF-8 replacement, and edit for targeted changes. ' +
        'Images are not supported by read. edit requires valid UTF-8.',
      'All edits in one edit call match the original file. Supply enough unique surrounding text for each change.',
      'Tool output is bounded and keeps its end. Interrupted bash, write and edit calls may have changed files; ' +
        'inspect with read or bash before retrying a mutation.',
    ].join('\n')),
  ],
});
