import { router, Stack, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatApp, useChatConversationState } from '@/chat/chat-provider';
import { ActionButton, InlineNotice } from '@/components/chat/primitives';
import { SettingRow, SettingsChoices, thinkingLevelLabel, type SettingsChoice } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';
import { createModelSettings, findCatalogModel, getModelSettingsError, type ChatModelSettings, type ModelThinkingLevel } from '@/pi/model-catalog';

import { sameExecution, validateExecution, type ChatExecutionSettings } from '@/pi/execution/document';
import { resolveRemoteWorkingDirectory } from '@/pi/execution/remote/test-host';

type Picker = 'provider' | 'model' | 'effort' | 'environment';

function dismissSettings(id: string) {
  if (router.canGoBack()) router.back();
  else router.replace({ pathname: '/chat/[id]', params: { id } });
}

export default function ChatSettingsRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const colors = useChatColors();
  const { ready, error: appError } = useChatApp();
  const { conversation, error } = useChatConversationState(id);
  if (!conversation) return <View style={[styles.loading, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: 'Chat settings', headerLeft: () => <HeaderAction title="Cancel" onPress={() => dismissSettings(id)} /> }} />
    {!ready && !appError ? <ActivityIndicator color={colors.accent} /> : <InlineNotice message={error || appError || 'This chat is no longer available.'} />}
  </View>;
  // Draft state belongs to this editor session; incoming chat snapshots do not
  // overwrite choices before the user saves or cancels.
  return <ChatSettingsEditor key={id} id={id} initialSettings={conversation.settings} initialExecution={conversation.execution} />;
}

function ChatSettingsEditor({ id, initialSettings, initialExecution }: { id: string; initialSettings: ChatModelSettings; initialExecution: ChatExecutionSettings }) {
  const colors = useChatColors();
  const insets = useSafeAreaInsets();
  const { ready, catalog, providerAccess, refreshCatalog, remoteHosts } = useChatApp();
  const { conversation, updateSettings, updateExecution } = useChatConversationState(id);
  const hosts = useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  const [execution, setExecution] = useState<ChatExecutionSettings>(initialExecution);
  const executionChanged = !sameExecution(execution, initialExecution);
  const selectedHost = execution.target.kind === 'ssh' ? hosts.hosts.find((host) => host.id === (execution.target as { machineId: string }).machineId) : undefined;
  let executionError: string | undefined;
  // An empty remote draft selects the account's home. Only its resolved absolute
  // path is committed; durable execution settings never contain this UI choice.
  const usesRemoteHome = execution.target.kind === 'ssh' && execution.cwd.trim() === '';
  if (!usesRemoteHome) {
    try { validateExecution(execution); } catch (cause) { executionError = (cause as Error).message; }
  }
  if (executionChanged && execution.target.kind === 'ssh' && !selectedHost) executionError = 'Choose an available remote machine.';
  const [draft, setDraft] = useState<ChatModelSettings>(initialSettings);
  const [picker, setPicker] = useState<Picker>();
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [checkingDirectory, setCheckingDirectory] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const savingRef = useRef(false);
  const directoryCheck = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const directoryDrafts = useRef(new Map([[initialExecution.target.kind === 'local' ? 'local' : initialExecution.target.machineId, initialExecution.cwd]]));
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') directoryCheck.current?.abort();
    });
    return () => { mounted.current = false; subscription.remove(); directoryCheck.current?.abort(); };
  }, []);
  const disableRemovalPrevention = usePreventRemove(saving || !!picker, () => {
    if (!saving && picker) { setSearch(''); setPicker(undefined); }
  });
  const provider = catalog.find((entry) => entry.id === draft.model.provider);
  const model = findCatalogModel(catalog, draft.model);
  const access = providerAccess(draft.model.provider);
  const settingsError = getModelSettingsError(catalog, draft);
  const canChooseEffort = !!model?.thinkingLevels.length && (model.thinkingLevels.length > 1 || !model.thinkingLevels.includes(draft.thinkingLevel));
  const blocked = !ready || !conversation || conversation.busy || conversation.pending;
  const disabled = blocked || saving || refreshing;
  const changed = draft.model.provider !== initialSettings.model.provider || draft.model.modelId !== initialSettings.model.modelId || draft.thinkingLevel !== initialSettings.thinkingLevel;
  const canSave = !disabled && (changed || executionChanged) && (!changed || !settingsError) && !executionError;
  const choosePage = (next?: Picker) => { setSearch(''); setPicker(next); setError(undefined); };
  const refresh = async () => {
    if (disabled) return;
    setRefreshing(true); setError(undefined);
    try { await refreshCatalog(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not refresh models. Try again.'); }
    finally { setRefreshing(false); }
  };
  const save = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true); setError(undefined);
    try {
      if (executionChanged) {
        let selected = execution;
        if (execution.target.kind === 'ssh') {
          const controller = new AbortController();
          directoryCheck.current = controller;
          setCheckingDirectory(true);
          const { cwd, hostRevision } = await resolveRemoteWorkingDirectory(remoteHosts, execution.target.machineId, execution.cwd,
            { signal: controller.signal });
          controller.signal.throwIfAborted();
          if (remoteHosts.get(execution.target.machineId)?.revision !== hostRevision) {
            throw new Error('This machine changed while its directory was being checked. Save again to use its updated settings.');
          }
          selected = { ...execution, cwd };
          directoryCheck.current = undefined;
          setCheckingDirectory(false);
        }
        await updateExecution(selected, changed ? draft : undefined);
      }
      else await updateSettings(draft);
      if (!mounted.current) return;
      setSaving(false);
      disableRemovalPrevention();
      dismissSettings(id);
    } catch (cause) {
      if (mounted.current) setError(directoryCheck.current?.signal.aborted ? 'Directory check cancelled.'
        : cause instanceof Error ? cause.message : 'Could not save these settings. Try again.');
    } finally {
      directoryCheck.current = undefined;
      savingRef.current = false;
      if (mounted.current) { setSaving(false); setCheckingDirectory(false); }
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
    : picker === 'provider'
    ? catalog.map((entry) => ({ id: entry.id, title: entry.name, description: entry.models.length ? `${entry.models.length} ${entry.models.length === 1 ? 'model' : 'models'}` : 'No models available', disabled: entry.models.length === 0 })).filter(matches)
    : picker === 'model'
      ? (provider?.models ?? []).map((entry) => ({ id: entry.id, title: entry.name, description: `${entry.id} · ${entry.reasoning ? 'Reasoning available' : 'No reasoning control'}` })).filter(matches)
      : (model?.thinkingLevels ?? []).map((level) => ({ id: level, title: thinkingLevelLabel(level) }));
  const selectedId = picker === 'environment' ? execution.target.kind === 'local' ? 'local' : execution.target.machineId : picker === 'provider' ? draft.model.provider : picker === 'model' ? draft.model.modelId : draft.thinkingLevel;
  const title = picker === 'environment' ? 'Execution environment' : picker === 'provider' ? 'Provider' : picker === 'model' ? 'Model' : picker === 'effort' ? 'Reasoning effort' : 'Chat settings';

  return <View testID="chat-settings-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title, gestureEnabled: !saving, headerBackVisible: false,
      headerLeft: () => <HeaderAction testID={picker ? 'settings-back' : 'cancel-chat-settings'} title={picker ? 'Back' : 'Cancel'} disabled={saving}
        onPress={() => { if (picker) choosePage(); else dismissSettings(id); }} />,
      headerRight: () => !picker ? <HeaderAction testID="save-chat-settings" title="Save" disabled={!canSave} loading={saving} onPress={() => { void save(); }} /> : null,
    }} />
    {picker ? <SettingsChoices choices={choices} selectedId={selectedId} disabled={disabled} bottomInset={insets.bottom}
      search={search} onSearch={picker === 'effort' ? undefined : setSearch} searchPlaceholder={picker === 'environment' ? 'Search machines' : picker === 'provider' ? 'Search providers' : 'Search models'}
      description={picker === 'environment' ? 'Choose where this chat reads, edits and runs commands. Files are not copied when you switch.' : picker === 'provider' ? 'Choose the provider for this chat.' : picker === 'model' ? `Choose a model from ${provider?.name || draft.model.provider}.` : 'Higher effort can take longer. The available levels depend on this model.'}
      onSelect={(value) => {
        if (picker === 'environment') {
          if (disabled) return;
          directoryDrafts.current.set(execution.target.kind === 'local' ? 'local' : execution.target.machineId, execution.cwd);
          setExecution(value === 'local' ? { target: { kind: 'local' }, cwd: directoryDrafts.current.get(value) ?? '/workspace' }
            : { target: { kind: 'ssh', machineId: value }, cwd: directoryDrafts.current.get(value) ?? '' });
          choosePage();
        } else if (picker === 'provider') selectProvider(value);
        else if (picker === 'model') selectModel(value);
        else { setDraft({ ...draft, thinkingLevel: value as ModelThinkingLevel }); choosePage(); }
      }} /> : <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
      <View style={styles.intro}>
        <Text style={[styles.chatTitle, { color: colors.text }]}>{conversation?.title || 'New chat'}</Text>
        <Text style={[styles.description, { color: colors.secondary }]}>These settings apply to the next response in this chat and are saved on this device.</Text>
      </View>
      {blocked && <InlineNotice tone="neutral" testID="settings-locked" message={conversation?.pending || conversation?.busy ? 'Finish or stop the current response before changing settings.' : 'Chat settings will be available when this chat finishes loading.'} />}
      {error && <InlineNotice testID="settings-save-error" message={error} />}
      {checkingDirectory && <View style={styles.directory}>
        <InlineNotice tone="neutral" message="Checking the working directory on this chat’s remote machine…" />
        <ActionButton testID="cancel-remote-directory-check" title="Cancel directory check" secondary onPress={() => directoryCheck.current?.abort()} />
      </View>}
      {settingsError && <InlineNotice testID="settings-unavailable" message={draft.model.modelId ? settingsError : 'Choose a model to finish changing the provider.'} />}
      <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <SettingRow testID="settings-provider" label="Provider" value={provider?.name || draft.model.provider} disabled={disabled} onPress={() => choosePage('provider')} />
        <SettingRow testID="settings-model" label="Model" value={model?.name || draft.model.modelId || 'Choose a model'}
          detail={model && model.id !== model.name ? model.id : undefined} disabled={disabled || !provider?.models.length} onPress={() => choosePage('model')} />
        <SettingRow testID="settings-effort" label="Reasoning effort" value={thinkingLevelLabel(draft.thinkingLevel)}
          detail={!model ? 'Choose an available model first.' : !model.reasoning ? 'This model does not support reasoning.' : model.thinkingLevels.length === 1 ? 'This model uses a fixed reasoning level.' : undefined}
          disabled={disabled || !canChooseEffort} onPress={() => choosePage('effort')} />
      </View>
      <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <SettingRow testID="settings-environment" label="Execution environment" value={execution.target.kind === 'local' ? 'On this device' : selectedHost?.name ?? 'Unavailable machine'}
          detail={execution.target.kind === 'ssh' ? selectedHost?.hostname ?? 'This machine was removed. Choose another environment.' : 'Local workspace'} disabled={disabled || !hosts.ready} onPress={() => choosePage('environment')} />
        <View style={styles.directory}>
          <Text style={{ color: colors.text, fontSize: 15 }}>Working directory</Text>
          <TextInput testID="settings-cwd" accessibilityLabel="Working directory" value={execution.cwd} onChangeText={(cwd) => setExecution({ ...execution, cwd })}
            editable={!disabled} autoCapitalize="none" autoCorrect={false} placeholder={execution.target.kind === 'ssh' ? 'Remote home directory' : '/workspace'} placeholderTextColor={colors.muted}
            style={[styles.directoryInput, { color: colors.text, borderColor: colors.border }]} />
          {execution.target.kind === 'ssh' && <Text style={[styles.caption, { color: colors.muted }]}>Choose an existing absolute path for this chat, or leave blank to use the remote account’s home directory.</Text>}
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

function HeaderAction({ title, onPress, disabled, loading, testID }: {
  title: string; onPress: () => void; disabled?: boolean; loading?: boolean; testID?: string;
}) {
  const colors = useChatColors();
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!disabled, busy: !!loading }}
    disabled={disabled || loading} onPress={onPress} style={({ pressed }) => [styles.headerAction, { opacity: disabled ? 0.4 : pressed ? 0.6 : 1 }]}>
    {loading ? <ActivityIndicator size="small" color={colors.accent} /> : <Text style={[styles.headerLabel, { color: colors.accent }]}>{title}</Text>}
  </Pressable>;
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
  headerAction: { minHeight: 44, minWidth: 48, justifyContent: 'center', alignItems: 'center' },
  headerLabel: { fontSize: 16, fontWeight: '500' },
});
