/** Keep the platform driver lazy while exposing the same factory to isolated runtime checks. */
export async function openWorkspaceDatabase(name?: string) {
  return (await import('./native')).openWorkspaceDatabase(name);
}
