import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useSyncExternalStore } from 'react';

import { useChatApp, useMachines } from '@/chat/chat-provider';
import {
  RemoteDirectoryPicker, displayPath, parentPath, useRemoteFolder,
} from '@/components/chat/remote-directory-picker';
import { useChatSettingsDraft } from '@/components/chat/settings-drafts';
import { useChatColors } from '@/hooks/use-chat-colors';

/**
 * One folder of the chat's remote machine; opening a folder pushes another of these screens. The first one shows the
 * draft working directory, or the machine's home directory when it is blank.
 */
export default function DirectoryScreen() {
  const { path } = useLocalSearchParams<{ path?: string }>();
  const { id, execution, setExecution, cwdText } = useChatSettingsDraft();
  const colors = useChatColors();
  const { remote, remoteHosts } = useChatApp();
  useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  const listed = useMachines();
  const target = execution.target;
  const machineId = target.kind === 'ssh' ? target.machineId : undefined;
  const host = machineId === undefined ? undefined : remoteHosts.get(machineId);
  const hostName = host && (listed?.machines[host.id]?.name ?? host.hostname);
  const browsePath = path ?? execution.cwd;
  // One request per shown folder; the toolbar's Choose reads the same answer the list shows.
  const { state: folder, reload } = useRemoteFolder(remote, machineId, browsePath);
  const shown = folder.status === 'ready' ? folder : undefined;
  const name = shown && displayPath(shown.path, shown.home);
  const title = name === undefined || name === '~' ? hostName ?? 'Folders' : name.slice(name.lastIndexOf('/') + 1);
  const choose = () => {
    if (!shown) return;
    setExecution({ ...execution, cwd: shown.path });
    cwdText.set(shown.path);
    router.dismissTo({ pathname: '/chat-settings/[id]', params: { id } });
  };
  return <>
    <Stack.Screen options={{ title }} />
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button variant="prominent" tintColor={colors.accent} disabled={!shown} onPress={choose}>
        Choose
      </Stack.Toolbar.Button>
    </Stack.Toolbar>
    {machineId !== undefined && <RemoteDirectoryPicker remote={remote} machineId={machineId}
      hostName={hostName ?? 'this machine'} path={browsePath} folder={folder}
      parent={path === undefined && shown ? parentPath(shown.path) : undefined}
      onOpen={(next) => router.push({ pathname: '/chat-settings/[id]/directory', params: { id, path: next } })}
      onRetry={reload} />}
  </>;
}
