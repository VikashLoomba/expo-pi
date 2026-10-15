import type { ConversationId } from '@earendil-works/pi-durable';
import { router, Stack, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatApp, useChatControls, useChatId, useChatStatus, useChatView } from '@/chat/chat-provider';
import { ActionButton, InlineNotice } from '@/components/chat/primitives';
import {
  RemoteDirectoryPicker, displayPath, parentPath, useRemoteFolder,
} from '@/components/chat/remote-directory-picker';
import {
  HeaderAction, ModelSettingRows, SettingRow, SettingsChoices, modelChoices, type SettingsChoice,
} from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { ChatView } from '@/pi/chat-view';
import {
  createModelSettings, findCatalogModel, getModelSettingsError, type ChatModelSettings,
} from '@/pi/model-catalog';

import { sameExecution, validateExecution, type ChatExecutionSettings } from '@/pi/execution/document';

type Picker = 'provider' | 'model' | 'effort' | 'environment' | 'directory';

function dismissSettings(id: string | ConversationId) {
  if (router.canGoBack()) router.back();
  else router.replace({ pathname: '/chat/[id]', params: { id } });
}

export default function ChatSettingsRoute() {
  const { id: routeId } = useLocalSearchParams<{ id: string }>();
  const id = useChatId(routeId);
  const colors = useChatColors();
  const { ready, error: appError } = useChatApp();
  const view = useChatView(id);
  const conversation = useChatControls(view);
  const status = useChatStatus(view);
  if (!conversation || id === undefined) return <View style={[styles.loading, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: 'Chat settings',
      headerLeft: () => <HeaderAction title="Cancel" onPress={() => dismissSettings(routeId)} /> }} />
    {(!ready || status === 'loading') && !appError && id !== undefined ? <ActivityIndicator color={colors.accent} />
      : <InlineNotice message={appError || 'This chat is no longer available.'} />}
  </View>;
  // Draft state belongs to this editor session; incoming chat snapshots do not
  // overwrite choices before the user saves or cancels.
  return <ChatSettingsEditor key={id} id={id} view={view} initialSettings={conversation.settings}
    initialExecution={conversation.execution} />;
}

function ChatSettingsEditor({ id, view, initialSettings, initialExecution }: {
  id: ConversationId; view: ChatView | undefined; initialSettings: ChatModelSettings;
  initialExecution: ChatExecutionSettings;
}) {
  const colors = useChatColors();
  const insets = useSafeAreaInsets();
  const { service, catalog, providerAccess, refreshCatalog, remoteHosts, remote } = useChatApp();
  const conversation = useChatControls(view);
  const hosts = useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  const [execution, setExecution] = useState<ChatExecutionSettings>(initialExecution);
  const executionChanged = !sameExecution(execution, initialExecution);
  const target = execution.target;
  const selectedHost = target.kind === 'ssh' ? hosts.hosts.find((host) => host.id === target.machineId) : undefined;
  let executionError: string | undefined;
  try { validateExecution(execution); }
  catch (cause) { executionError = cause instanceof Error ? cause.message : String(cause); }
  if (executionChanged && execution.target.kind === 'ssh' && !selectedHost) executionError = 'Choose an available remote machine.';
  const [draft, setDraft] = useState<ChatModelSettings>(initialSettings);
  const [picker, setPicker] = useState<Picker>();
  const [search, setSearch] = useState('');
  // The absolute folder the picker shows, `null` for the machine's home; undefined starts at the draft directory.
  const [directoryPath, setDirectoryPath] = useState<string | null>();
  const browsing = picker === 'directory' && target.kind === 'ssh' ? target.machineId : undefined;
  const browsePath = directoryPath === undefined ? execution.cwd : directoryPath;
  // One request per shown folder; the header's Back and Choose read the same answer the picker lists.
  const { state: folder, reload: reloadFolder } = useRemoteFolder(remote, browsing, browsePath);
  const shownFolder = folder.status === 'ready' ? folder : undefined;
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const savingRef = useRef(false);
  const mounted = useRef(true);
  const directoryDrafts = useRef(new Map([[initialExecution.target.kind === 'local' ? 'local' : initialExecution.target.machineId, initialExecution.cwd]]));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const disableRemovalPrevention = usePreventRemove(saving || !!picker, () => {
    if (!saving && picker) { setSearch(''); setPicker(undefined); }
  });
  const provider = catalog.find((entry) => entry.id === draft.model.provider);
  const model = findCatalogModel(catalog, draft.model);
  const access = providerAccess(draft.model.provider);
  const settingsError = getModelSettingsError(catalog, draft);
  const blocked = !service || !conversation;
  const disabled = blocked || saving || refreshing;
  const changed = draft.model.provider !== initialSettings.model.provider || draft.model.modelId !== initialSettings.model.modelId || draft.thinkingLevel !== initialSettings.thinkingLevel;
  const canSave = !disabled && (changed || executionChanged) && (!changed || !settingsError) && !executionError;
  const choosePage = (next?: Picker) => { setSearch(''); setDirectoryPath(undefined); setPicker(next); setError(undefined); };
  const chooseDirectory = () => {
    if (!shownFolder) return;
    setExecution({ ...execution, cwd: shownFolder.path });
    choosePage();
  };
  const refresh = async () => {
    if (disabled) return;
    setRefreshing(true); setError(undefined);
    try { await refreshCatalog(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not refresh models. Try again.'); }
    finally { setRefreshing(false); }
  };
  const save = async () => {
    if (!service || !canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true); setError(undefined);
    try {
      if (executionChanged) await service.updateExecution(id, execution, changed ? draft : undefined);
      else await service.updateSettings(id, draft);
      if (!mounted.current) return;
      setSaving(false);
      disableRemovalPrevention();
      dismissSettings(id);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not save these settings. Try again.');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const selectProvider = (providerId: string) => {
    if (disabled) return;
    if (providerId !== draft.model.provider) setDraft({ model: { provider: providerId, modelId: '' }, thinkingLevel: draft.thinkingLevel });
    choosePage('model');
  };
  const selectModel = (modelId: string) => {
    const selected = provider?.models.find((entry) => entry.id === modelId);
    if (!selected || disabled) return;
    setDraft(createModelSettings(selected, draft.thinkingLevel));
    choosePage();
  };
  const query = search.trim().toLocaleLowerCase();
  const matches = (choice: SettingsChoice) => `${choice.title} ${choice.description || ''}`.toLocaleLowerCase().includes(query);
  const choices: SettingsChoice[] = picker === 'environment'
    ? [{ id: 'local', title: 'On this device', description: 'This chat’s local workspace' }, ...hosts.hosts.map((host) => ({ id: host.id, title: host.name, description: `${host.username}@${host.hostname} · SSH over Tailscale` }))].filter(matches)
    : picker === 'provider' || picker === 'model' ? modelChoices(catalog, draft, picker).filter(matches)
      : modelChoices(catalog, draft, 'effort');
  const selectedId = picker === 'environment' ? execution.target.kind === 'local' ? 'local' : execution.target.machineId : picker === 'provider' ? draft.model.provider : picker === 'model' ? draft.model.modelId : draft.thinkingLevel;
  const shownName = shownFolder && displayPath(shownFolder.path, shownFolder.home);
  const title = picker === 'directory' ? (shownName === undefined || shownName === '~' ? selectedHost?.name ?? 'Folders' : shownName.slice(shownName.lastIndexOf('/') + 1))
    : picker === 'environment' ? 'Execution environment' : picker === 'provider' ? 'Provider' : picker === 'model' ? 'Model' : picker === 'effort' ? 'Reasoning effort' : 'Chat settings';

  return <View testID="chat-settings-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title, gestureEnabled: !saving, headerBackVisible: false,
      headerLeft: () => <HeaderAction testID={picker ? 'settings-back' : 'cancel-chat-settings'} title={picker ? 'Back' : 'Cancel'} disabled={saving}
        onPress={() => {
          // In the folder picker, Back climbs to the parent folder first, as the Files app does.
          const parent = shownFolder && parentPath(shownFolder.path);
          if (picker === 'directory' && parent !== undefined) setDirectoryPath(parent);
          else if (picker) choosePage();
          else dismissSettings(id);
        }} />,
      headerRight: () => !picker ? <HeaderAction testID="save-chat-settings" title="Save" disabled={!canSave} loading={saving} onPress={() => { void save(); }} />
        : picker === 'directory' ? <HeaderAction testID="choose-directory" title="Choose" disabled={!shownFolder} onPress={chooseDirectory} /> : null,
    }} />
    {picker === 'directory' && browsing !== undefined ? <RemoteDirectoryPicker remote={remote} machineId={browsing}
      hostName={selectedHost?.name ?? 'this machine'} path={browsePath} folder={folder} onOpen={setDirectoryPath}
      onRetry={reloadFolder} />
    : picker ? <SettingsChoices choices={choices} selectedId={selectedId} disabled={disabled} bottomInset={insets.bottom}
      search={search} onSearch={picker === 'effort' ? undefined : setSearch} searchPlaceholder={picker === 'environment' ? 'Search machines' : picker === 'provider' ? 'Search providers' : 'Search models'}
      description={picker === 'environment' ? 'Choose where this chat reads, edits and runs commands. Files are not copied when you switch.' : picker === 'provider' ? 'Choose the provider for this chat.' : picker === 'model' ? `Choose a model from ${provider?.name || draft.model.provider}.` : 'Higher effort can take longer. The available levels depend on this model.'}
      onSelect={(value) => {
        if (picker === 'environment') {
          if (disabled) return;
          directoryDrafts.current.set(execution.target.kind === 'local' ? 'local' : execution.target.machineId, execution.cwd);
          setExecution(value === 'local' ? { target: { kind: 'local' }, cwd: directoryDrafts.current.get(value) ?? '/workspace' }
            : { target: { kind: 'ssh', machineId: value }, cwd: directoryDrafts.current.get(value) ?? null });
          choosePage();
        } else if (picker === 'provider') selectProvider(value);
        else if (picker === 'model') selectModel(value);
        else {
          const thinkingLevel = model?.thinkingLevels.find((level) => level === value);
          if (thinkingLevel) setDraft({ ...draft, thinkingLevel });
          choosePage();
        }
      }} /> : <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
      <View style={styles.intro}>
        <Text style={[styles.chatTitle, { color: colors.text }]}>{conversation?.title || 'New chat'}</Text>
        <Text style={[styles.description, { color: colors.secondary }]}>These settings apply to the next response in this chat and are saved on this device.</Text>
      </View>
      {blocked && <InlineNotice tone="neutral" testID="settings-locked"
        message="Chat settings will be available when this chat finishes loading." />}
      {error && <InlineNotice testID="settings-save-error" message={error} />}
      {settingsError && <InlineNotice testID="settings-unavailable" message={draft.model.modelId ? settingsError : 'Choose a model to finish changing the provider.'} />}
      <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <ModelSettingRows testID="settings" catalog={catalog} settings={draft} disabled={disabled}
          onOpen={choosePage} />
      </View>
      <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <SettingRow testID="settings-environment" label="Execution environment" value={execution.target.kind === 'local' ? 'On this device' : selectedHost?.name ?? 'Unavailable machine'}
          detail={execution.target.kind === 'ssh' ? selectedHost?.hostname ?? 'This machine was removed. Choose another environment.' : 'Local workspace'} disabled={disabled || !hosts.ready} onPress={() => choosePage('environment')} />
        <View style={styles.directory}>
          <Text style={{ color: colors.text, fontSize: 15 }}>Working directory</Text>
          <TextInput testID="settings-cwd" accessibilityLabel="Working directory" value={execution.cwd ?? ''}
            onChangeText={(cwd) => setExecution({ ...execution, cwd: cwd.trim() ? cwd : null })}
            editable={!disabled} autoCapitalize="none" autoCorrect={false} placeholder={execution.target.kind === 'ssh' ? 'Remote home directory' : '/workspace'} placeholderTextColor={colors.muted}
            style={[styles.directoryInput, { color: colors.text, borderColor: colors.border }]} />
          {execution.target.kind === 'ssh' && <>
            <ActionButton testID="browse-directories" title="Choose a folder" secondary icon="folder" disabled={disabled || !selectedHost}
              onPress={() => choosePage('directory')} />
            <Text style={[styles.caption, { color: colors.muted }]}>Choose a folder on this machine, or enter an absolute path. Leave blank to use the machine’s home directory.</Text>
          </>}
        </View>
      </View>
      {executionError && <InlineNotice testID="settings-execution-error" message={executionError} />}
      {hosts.error && <InlineNotice message={hosts.error} />}
      <ActionButton testID="manage-remote-hosts" title="Manage remote machines" secondary disabled={saving} onPress={() => router.push('/remote-hosts')} />
      <Text style={[styles.caption, { color: colors.muted }]}>Remote execution uses your phone’s existing Tailscale VPN and the machine’s SSH server. Switching environments does not copy files. Remote forks share the machine’s current files.</Text>
      {!access.connected && <InlineNotice tone="neutral" testID="settings-connection" message={access.error || `Connect ${provider?.name || draft.model.provider} in Account before sending a message. You can save your choice now.`}
        action={saving ? undefined : 'Open account'} onAction={() => {
          if (!savingRef.current) router.push({ pathname: '/account', params: { provider: draft.model.provider } });
        }} />}
      <ActionButton testID="refresh-chat-models" title="Refresh models" secondary icon="retry" loading={refreshing}
        disabled={blocked || saving} onPress={() => { void refresh(); }} />
      <Text style={[styles.caption, { color: colors.muted }]}>You can choose a different provider or model for each chat. Changing these settings keeps your conversation history.</Text>
    </ScrollView>}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', padding: 20, gap: 20 },
  intro: { gap: 8, paddingTop: 6 },
  chatTitle: { fontSize: 22, fontWeight: '600' },
  description: { fontSize: 14, lineHeight: 22 },
  group: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, overflow: 'hidden' },
  caption: { fontSize: 12, lineHeight: 19, paddingHorizontal: 3 },
  directory: { padding: 16, gap: 10 },
  directoryInput: { minHeight: 44, padding: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, fontSize: 15 },
});
