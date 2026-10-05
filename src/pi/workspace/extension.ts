import { defineExtension, section } from '@earendil-works/pi-durable';
import { BASH_CAPABILITY_DESCRIPTION } from '../bash/engine/index';
import { createBashTool } from '../bash/tool';
import { WORKSPACE_EXTENSION, WorkspaceDoc } from './document';
import { createWorkspaceFileTools } from './file-tools';
import type { WorkspaceRuntime } from './runtime';

export function createWorkspaceExtension(workspaces: WorkspaceRuntime) {
  return defineExtension({
    // Persisted extension selections retain their existing identity.
    name: WORKSPACE_EXTENSION,
    sections: [section('local_workspace', async ({ conversationId, read }, context) => {
      const workspace = await read.snapshot(WorkspaceDoc, conversationId, context);
      return [
        'The read, write, edit and bash tools share this chat’s local filesystem. /workspace persists across app restarts; relative paths, HOME and the default cwd resolve there.',
        '/tmp and the system filesystem are recreated for every tool invocation. Bash starts with fresh shell variables, functions and cwd; only /workspace files persist.',
        'Use read for paged text (positive 1-based offset and limit), write for full UTF-8 replacement, and edit for targeted changes. Images are not supported by read. Binary reads may show replacement characters; edit requires valid UTF-8.',
        'All edits in one edit call match the original file. Supply enough unique surrounding text; split expensive changes into smaller calls or use write for a complete replacement. Large edit patches are saved under /workspace/.edit-output when space permits.',
        'Use redirection for binary artifacts. Output is buffered and bounded; larger textual output is saved under /workspace/.bash-output when space permits.',
        'Interrupted bash, write and edit calls may have changed files. Inspect with read or bash before retrying a mutation.',
        workspace?.origin === 'fork' ? 'This conversation fork started with an empty workspace. Files mentioned in inherited messages were NOT copied or restored.' : '',
        BASH_CAPABILITY_DESCRIPTION,
      ].filter(Boolean).join('\n');
    })],
    tools: [createBashTool(workspaces), ...createWorkspaceFileTools(workspaces)],
  });
}
