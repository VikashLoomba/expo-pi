/**
 * Process-local opened-file ownership. Workspace IDs are globally unique and
 * coordination spans database connections, just like the runtime workspace queue.
 * Pinned orphan rows still count against all existing byte/inode quotas.
 */
const retained = new Map<string, Map<number, number>>();

export function retainedInodeCount(workspace: string, id: number): number {
  return retained.get(workspace)?.get(id) ?? 0;
}
export function retainInode(workspace: string, id: number): void {
  let inodes = retained.get(workspace);
  if (!inodes) { inodes = new Map(); retained.set(workspace, inodes); }
  inodes.set(id, (inodes.get(id) ?? 0) + 1);
}
export function releaseInode(workspace: string, id: number): void {
  const inodes = retained.get(workspace);
  if (!inodes) return;
  const count = (inodes.get(id) ?? 0) - 1;
  if (count > 0) inodes.set(id, count);
  else inodes.delete(id);
  if (!inodes.size) retained.delete(workspace);
}
