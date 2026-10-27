import { ExecutionError, FileError } from '@earendil-works/pi-durable/env';
import {
  Button, Host, HStack, Image, Label, List, ProgressView, Section, Spacer, Text, TextField, VStack, useNativeState,
} from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled, buttonStyle, font, foregroundStyle, headerProminence, listStyle, scrollDismissesKeyboard,
  submitLabel, textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StyleSheet } from 'react-native';

import { useChatColors } from '@/hooks/use-chat-colors';
import type { RemoteExecution, RemoteFolder, RemoteFolderSearch } from '@/pi/execution/remote/owner';

export type RemoteFolderState =
  | { status: 'loading' }
  | { status: 'failed'; error: string }
  | ({ status: 'ready' } & RemoteFolder);

export type RemoteFolderSearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'failed'; error: string }
  | ({ status: 'ready' } & RemoteFolderSearch);

/** How long typing pauses before a search runs on the machine. */
const SEARCH_DEBOUNCE_MS = 400;

function remoteFailureMessage(error: unknown, fallback: string): string {
  if (error instanceof FileError) {
    if (error.code === 'not_found') return 'This folder no longer exists on the machine.';
    if (error.code === 'not_directory') return 'This path is a file, not a folder.';
    if (error.code === 'permission_denied') return 'The SSH account cannot read this folder.';
    // A connection that fails to start says why in the app's own text or the SSH failure's sanitized one
    // (`connectionFailure`), never the native diagnostics.
    return error.message;
  }
  if (error instanceof ExecutionError) {
    return error.code === 'spawn_error' || error.code === 'shell_unavailable'
      ? 'This machine cannot run find, so folders cannot be searched. Open folders instead.' : error.message;
  }
  return error instanceof Error ? error.message : fallback;
}

/** One folder of a machine while `machineId` is set; `null` is its home directory. Leaving cancels the request. */
export function useRemoteFolder(remote: RemoteExecution, machineId: string | undefined, path: string | null) {
  const [attempt, setAttempt] = useState(0);
  const key = machineId === undefined ? undefined : `${machineId}\n${path ?? ''}\n${attempt}`;
  const [result, setResult] = useState<{ key: string; state: RemoteFolderState }>();
  useEffect(() => {
    if (machineId === undefined || key === undefined) return;
    const controller = new AbortController();
    remote.listFolder(machineId, path, controller.signal).then(
      (folder) => { if (!controller.signal.aborted) setResult({ key, state: { status: 'ready', ...folder } }); },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ key, state: { status: 'failed', error: remoteFailureMessage(error, 'Folders could not be listed.') } });
      },
    );
    return () => controller.abort();
  }, [remote, machineId, path, key]);
  const reload = useCallback(() => setAttempt((count) => count + 1), []);
  const state: RemoteFolderState = result !== undefined && result.key === key ? result.state : { status: 'loading' };
  return { state, reload };
}

/** Folders below `root` named like `query`, searched once typing pauses; a new query cancels the running search. */
export function useRemoteFolderSearch(remote: RemoteExecution, machineId: string | undefined, root: string | undefined,
  query: string): RemoteFolderSearchState {
  const needle = query.trim();
  const key = machineId === undefined || root === undefined || !needle ? undefined : `${machineId}\n${root}\n${needle}`;
  const [result, setResult] = useState<{ key: string; state: RemoteFolderSearchState }>();
  useEffect(() => {
    if (machineId === undefined || root === undefined || key === undefined) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      remote.searchFolders(machineId, root, needle, controller.signal).then(
        (found) => { if (!controller.signal.aborted) setResult({ key, state: { status: 'ready', ...found } }); },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setResult({ key, state: { status: 'failed', error: remoteFailureMessage(error, 'Folders could not be searched.') } });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [remote, machineId, root, needle, key]);
  if (key === undefined) return { status: 'idle' };
  return result !== undefined && result.key === key ? result.state : { status: 'searching' };
}

const trimSlashes = (path: string) => path.replace(/\/+$/, '') || '/';
const nameOf = (path: string) => trimSlashes(path).slice(trimSlashes(path).lastIndexOf('/') + 1);
export const childPath = (parent: string, name: string) => `${trimSlashes(parent) === '/' ? '' : trimSlashes(parent)}/${name}`;
/** The folder above `path`, or undefined at the root. */
export function parentPath(path: string): string | undefined {
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

type FolderRow = { path: string; name: string; subtitle?: string };

const secondaryText = [foregroundStyle({ type: 'hierarchical', style: 'secondary' })];

function FolderRowView({ row, onOpen }: { row: FolderRow; onOpen: (path: string) => void }) {
  const colors = useChatColors();
  return <Button onPress={() => onOpen(row.path)} modifiers={[buttonStyle('plain')]}>
    <HStack spacing={12}>
      <Image systemName="folder" color={colors.accent} size={20} />
      <VStack alignment="leading" spacing={2}>
        <Text>{row.name}</Text>
        {row.subtitle ? <Text modifiers={[font({ textStyle: 'footnote' }), ...secondaryText]}>{row.subtitle}</Text> : null}
      </VStack>
      <Spacer />
      <Image systemName="chevron.right" color={colors.muted} size={13} />
    </HStack>
  </Button>;
}

function Unavailable({ error, onRetry }: { error: string; onRetry: () => void }) {
  const colors = useChatColors();
  return <VStack spacing={16}>
    <Image systemName="folder.badge.questionmark" color={colors.muted} size={44} />
    <Text modifiers={[font({ textStyle: 'headline' })]}>Folder unavailable</Text>
    <Text modifiers={[...secondaryText, font({ textStyle: 'subheadline' })]}>{error}</Text>
    <Button label="Try again" onPress={onRetry} modifiers={[buttonStyle('bordered')]} />
  </VStack>;
}

/**
 * A native folder browser for a remote machine: tap a folder to open it, search to find one a few levels below the
 * shown folder. Each folder is its own screen, so the back button goes up; `parent` offers the folder above the one
 * the browser opened at, which no earlier screen shows.
 */
export function RemoteDirectoryPicker({ remote, machineId, hostName, path, folder, parent, onOpen, onRetry }: {
  remote: RemoteExecution; machineId: string; hostName: string; path: string | null; folder: RemoteFolderState;
  parent?: string; onOpen: (path: string) => void; onRetry: () => void;
}) {
  const colors = useChatColors();
  const search = useNativeState('');
  const [query, setQuery] = useState('');
  const home = folder.status === 'ready' ? folder.home : undefined;
  const found = useRemoteFolderSearch(remote, machineId, folder.status === 'ready' ? folder.path : undefined, query);
  const open = useCallback((next: string) => {
    search.set('');
    setQuery('');
    onOpen(next);
  }, [onOpen, search]);
  const rows = useMemo((): FolderRow[] => {
    if (folder.status !== 'ready') return [];
    if (found.status === 'ready') {
      return found.matches.map((match) => ({ path: match, name: nameOf(match),
        subtitle: displayPath(parentPath(match) ?? '/', home) }));
    }
    if (found.status !== 'idle') return [];
    return folder.names.map((name) => ({ path: childPath(folder.path, name), name }));
  }, [folder, found, home]);
  const renderRow = useCallback(({ item }: { item: FolderRow }) => <FolderRowView row={item} onOpen={open} />, [open]);
  if (folder.status === 'loading') {
    return <Host style={styles.host} seedColor={colors.accent} testID="directory-picker-loading">
      <VStack spacing={14}>
        <ProgressView />
        <Text modifiers={secondaryText}>{path === null ? `Connecting to ${hostName}…` : 'Opening folder…'}</Text>
      </VStack>
    </Host>;
  }
  if (folder.status === 'failed') {
    return <Host style={styles.host} seedColor={colors.accent} testID="directory-picker-error">
      <Unavailable error={folder.error} onRetry={onRetry} />
    </Host>;
  }
  const searching = found.status !== 'idle';
  const header = searching ? `Folders matching “${query.trim()}”` : displayPath(folder.path, home);
  const footer = found.status === 'ready' && found.stoppedEarly
    ? 'The search ran out of time, so some folders may be missing. Open a folder to search closer to it.'
    : searching ? `Searches up to four levels below ${displayPath(folder.path, home)}. Hidden folders are not shown.`
    : 'Hidden folders are not shown. You can also type a path in the working directory field.';
  const empty = found.status === 'searching' ? 'Searching…'
    : found.status === 'failed' ? found.error
    : searching ? 'No folders match.' : 'No folders inside.';
  return <Host style={styles.host} seedColor={colors.accent} testID="directory-picker">
    <List modifiers={[listStyle('insetGrouped'), scrollDismissesKeyboard('interactively')]}>
      <Section>
        <TextField placeholder="Search folders" text={search} onTextChange={setQuery}
          modifiers={[autocorrectionDisabled(), textInputAutocapitalization('never'), submitLabel('search')]} />
      </Section>
      <Section header={<Text>{header}</Text>} footer={<Text>{footer}</Text>} modifiers={[headerProminence('increased')]}>
        {!searching && parent !== undefined && <Button onPress={() => open(parent)}>
          <Label title="Enclosing folder" systemImage="arrow.turn.left.up" />
        </Button>}
        {rows.length
          ? <List.ForEach data={rows} keyExtractor={(row) => row.path} estimatedItemSize={44}>{renderRow}</List.ForEach>
          : <Text modifiers={secondaryText}>{empty}</Text>}
      </Section>
    </List>
  </Host>;
}

const styles = StyleSheet.create({
  host: { flex: 1 },
});
