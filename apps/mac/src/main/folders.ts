import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

/** One folder of a machine, as its environment lists it: the account's home, the folder's path, the folders inside. */
export interface Folder { home: string; path: string; names: string[] }
/** The folders found below a root; `stoppedEarly` when the search's time ran out before the whole tree. */
export interface FolderSearch { matches: string[]; stoppedEarly: boolean }

/** Levels below the searched folder that `searchFolders` visits, and how long it may take. */
const SEARCH_DEPTH = 4;
const SEARCH_TIMEOUT_SECONDS = 10;
/** `find`'s patterns are shell globs; a query is matched literally. */
const globLiteral = (text: string) => text.replace(/[\\*?[\]]/g, '\\$&');

/**
 * The chat settings' directory browser over a machine's environment, as the phone's `owner.ts` lists and searches
 * folders through the connection the chat's tools share: one level at a time, the home directory for `null`, and
 * `find` for folders named like a query a few levels down, run without a shell. Hidden folders are left out.
 */
export async function listFolder(env: ExecutionEnv, path: string | null, signal: AbortSignal): Promise<Folder> {
  const home = env.cwd;
  const target = path ?? home;
  const listed = await env.listDir(target, withAbortSignal(signal, BACKGROUND_CONTEXT));
  if (!listed.ok) throw listed.error;
  const names = listed.value.flatMap((entry) =>
    entry.kind === 'directory' && !entry.name.startsWith('.') ? [entry.name] : []);
  return { home, path: target, names };
}

export async function searchFolders(env: ExecutionEnv, root: string, query: string,
  signal: AbortSignal): Promise<FolderSearch> {
  let output = '';
  const result = await env.exec(
    ['find', root, '-mindepth', '1', '-maxdepth', String(SEARCH_DEPTH), '-name', '.*', '-prune', '-o',
      '-type', 'd', '-iname', `*${globLiteral(query)}*`, '-print'],
    { timeout: SEARCH_TIMEOUT_SECONDS, onOutput: (text, _context, info) => {
      if (info.stream === 'stdout') output += text;
    } },
    withAbortSignal(signal, BACKGROUND_CONTEXT));
  // Unreadable folders make `find` exit nonzero after printing what it could; those matches are still right.
  if (!result.ok && result.error.code !== 'timeout') throw result.error;
  const matches = output.split('\n').filter((line) => line.startsWith('/')).sort();
  return { matches, stoppedEarly: !result.ok };
}
