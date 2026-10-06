import { uuidv7 } from '@earendil-works/pi-ai';
import type { WorkspaceInvocation } from '../workspace/runtime';
import type { ArtifactWriter } from './types';

/** Called inside the bound workspace lease; ordinary workspace paths survive its release. */
export function createWorkspaceArtifactWriter(
  { mounted, signal }: Pick<WorkspaceInvocation, 'mounted' | 'signal'>,
): ArtifactWriter {
  return {
    async write(kind, content, context) {
      const active = () => { context.abortSignal?.throwIfAborted(); signal.throwIfAborted(); };
      active();
      const directory = kind === 'edit-patch' ? '/workspace/.edit-output' : '/workspace/.bash-output';
      try { await mounted.mkdir(directory); }
      catch (cause) {
        active();
        const stat = await mounted.lstat(directory);
        if (!stat.isDirectory || stat.isSymbolicLink) throw cause;
      }
      const stat = await mounted.lstat(directory);
      if (!stat.isDirectory || stat.isSymbolicLink) throw new Error('Artifact output directory must be a real directory.');
      if (!mounted.createExclusive) throw new Error('The workspace cannot create artifacts exclusively.');
      const suffix = kind === 'edit-patch' ? 'patch' : `${kind.slice(5)}.txt`;
      const path = `${directory}/${uuidv7()}.${suffix}`;
      active();
      await mounted.createExclusive(path, { mode: 0o600 });
      try {
        active();
        await mounted.writeFile(path, content);
        active();
        return path;
      } catch (cause) {
        if (!signal.aborted && !context.abortSignal?.aborted) await mounted.rm(path).catch(() => {});
        throw cause;
      }
    },
  };
}
