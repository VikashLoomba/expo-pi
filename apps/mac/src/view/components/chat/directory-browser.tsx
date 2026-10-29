import { CornerLeftUpIcon, FolderIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ChatRef } from '../../hooks/use-chats';
import { errorText } from '../../hooks/use-ref';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Spinner } from '../ui/spinner';

type Folder = Awaited<ReturnType<ChatRef['listFolder']>>;
type FolderSearch = Awaited<ReturnType<ChatRef['searchFolders']>>;
type FolderState = { status: 'loading' } | { status: 'failed'; error: string } | ({ status: 'ready' } & Folder);
type SearchState = { status: 'idle' } | { status: 'searching' } | { status: 'failed'; error: string }
  | ({ status: 'ready' } & FolderSearch);

/** How long typing pauses before a search runs on the machine. */
const SEARCH_DEBOUNCE_MS = 400;

const trimSlashes = (path: string) => path.replace(/\/+$/, '') || '/';
const nameOf = (path: string) => trimSlashes(path).slice(trimSlashes(path).lastIndexOf('/') + 1);
const childPath = (parent: string, name: string) =>
  `${trimSlashes(parent) === '/' ? '' : trimSlashes(parent)}/${name}`;
/** The folder above `path`, or undefined at the root. */
function parentPath(path: string): string | undefined {
  const trimmed = trimSlashes(path);
  if (trimmed === '/') return undefined;
  return trimmed.slice(0, trimmed.lastIndexOf('/')) || '/';
}
/** A path shown with `~` for the home directory, as a shell would. */
export function displayPath(path: string, home: string | undefined): string {
  if (home === undefined) return path;
  const base = trimSlashes(home);
  const target = trimSlashes(path);
  if (target === base) return '~';
  return target.startsWith(`${base}/`) ? `~${target.slice(base.length)}` : target;
}

/** One folder of the machine; `null` is its home directory. A newer request's answer replaces an older one's. */
function useFolder(chat: ChatRef, machineId: string, path: string | null) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; state: FolderState }>();
  const key = `${machineId}\n${path ?? ''}\n${attempt}`;
  useEffect(() => {
    let current = true;
    chat.listFolder({ machineId, path }).then(
      (folder) => { if (current) setResult({ key, state: { status: 'ready', ...folder } }); },
      (cause: unknown) => {
        if (current) setResult({ key, state: { status: 'failed', error: errorText(cause, 'Folders could not be listed.') } });
      });
    return () => { current = false; };
  }, [chat, machineId, path, key]);
  const state: FolderState = result?.key === key ? result.state : { status: 'loading' };
  return { state, reload: () => setAttempt((count) => count + 1) };
}

/** Folders below `root` named like `query`, searched once typing pauses. */
function useFolderSearch(chat: ChatRef, machineId: string, root: string | undefined, query: string): SearchState {
  const needle = query.trim();
  const key = root === undefined || !needle ? undefined : `${machineId}\n${root}\n${needle}`;
  const [result, setResult] = useState<{ key: string; state: SearchState }>();
  useEffect(() => {
    if (root === undefined || key === undefined) return;
    let current = true;
    const timer = setTimeout(() => {
      chat.searchFolders({ machineId, root, query: needle }).then(
        (found) => { if (current) setResult({ key, state: { status: 'ready', ...found } }); },
        (cause: unknown) => {
          if (current) setResult({ key, state: { status: 'failed', error: errorText(cause, 'Folders could not be searched.') } });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [chat, machineId, root, needle, key]);
  if (key === undefined) return { status: 'idle' };
  return result?.key === key ? result.state : { status: 'searching' };
}

function FolderRow({ name, subtitle, icon, onOpen }: {
  name: string; subtitle?: string; icon?: 'up'; onOpen: () => void;
}) {
  return (
    <button type="button" onClick={onOpen}
      className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent focus-visible:bg-accent
        focus-visible:outline-none">
      {icon === 'up' ? <CornerLeftUpIcon className="size-4 text-muted-foreground" />
        : <FolderIcon className="size-4 text-primary" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{name}</span>
        {subtitle !== undefined && <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
    </button>
  );
}

/**
 * The folder browser for a chat on a machine, as the phone's `RemoteDirectoryPicker`: a folder opens on a click, the
 * enclosing folder goes up, and a search finds folders a few levels below the shown one. Choose takes the shown
 * folder; the browser opens at the chat's working directory, or the machine's home.
 */
export function DirectoryBrowser({ chat, machineId, machineName, start, onChoose, onCancel }: {
  chat: ChatRef; machineId: string; machineName: string; start: string | null;
  onChoose: (path: string) => void; onCancel: () => void;
}) {
  const [path, setPath] = useState(start);
  const [query, setQuery] = useState('');
  const { state: folder, reload } = useFolder(chat, machineId, path);
  const shown = folder.status === 'ready' ? folder : undefined;
  const found = useFolderSearch(chat, machineId, shown?.path, query);
  const open = (next: string) => {
    setQuery('');
    setPath(next);
  };
  const searching = found.status !== 'idle';
  const parent = shown && !searching ? parentPath(shown.path) : undefined;
  const rows: { path: string; name: string; subtitle?: string }[] = shown === undefined ? []
    : found.status === 'ready' ? found.matches.map((match) => ({ path: match, name: nameOf(match),
      subtitle: displayPath(parentPath(match) ?? '/', shown.home) }))
      : found.status !== 'idle' ? [] : shown.names.map((name) => ({ path: childPath(shown.path, name), name }));
  const empty = found.status === 'searching' ? 'Searching…' : found.status === 'failed' ? found.error
    : searching ? 'No folders match.' : 'No folders inside.';
  const footer = found.status === 'ready' && found.stoppedEarly
    ? 'The search ran out of time, so some folders may be missing. Open a folder to search closer to it.'
    : searching ? `Searches up to four levels below ${displayPath(shown?.path ?? '/', shown?.home)}.`
      : 'Hidden folders are not shown. You can also type a path in the working directory field.';
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2 text-sm font-medium">
        <span className="truncate">{shown ? displayPath(shown.path, shown.home) : machineName}</span>
        {folder.status === 'loading' && <Spinner />}
      </div>
      {shown && (
        <Input value={query} placeholder="Search folders" aria-label="Search folders"
          onChange={(event) => setQuery(event.target.value)} />
      )}
      <div className="max-h-56 overflow-y-auto rounded-md border text-sm">
        {folder.status === 'loading' && (
          <p className="p-3 text-muted-foreground">{path === null ? `Connecting to ${machineName}…` : 'Opening folder…'}</p>
        )}
        {folder.status === 'failed' && (
          <div className="flex flex-col items-start gap-2 p-3">
            <p className="text-destructive">{folder.error}</p>
            <Button type="button" variant="outline" size="xs" onClick={reload}>Try Again</Button>
          </div>
        )}
        {parent !== undefined && <FolderRow name="Enclosing folder" icon="up" onOpen={() => open(parent)} />}
        {shown && rows.map((row) => (
          <FolderRow key={row.path} name={row.name} subtitle={row.subtitle} onOpen={() => open(row.path)} />
        ))}
        {shown && rows.length === 0 && <p className="p-3 text-muted-foreground">{empty}</p>}
      </div>
      <p className="text-xs text-muted-foreground">{footer}</p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="button" size="sm" disabled={shown === undefined}
          onClick={() => { if (shown) onChoose(shown.path); }}>Choose</Button>
      </div>
    </div>
  );
}
