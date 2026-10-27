import type { ConversationId } from '@earendil-works/pi-durable';
import { Button, Form, Host, LabeledContent, Picker, Section, Text, TextField } from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled, disabled as disable, pickerStyle, tag, textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import {
  sameExecution, validateExecution, type ChatExecutionSettings,
} from '@pi-agent/infinichat/pi/execution/document';
import { getModelSettingsError } from '@pi-agent/infinichat/pi/model-catalog';
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { useChatApp, useChatControls } from '@/chat/chat-provider';
import { ModelSection, SectionFooter, SettingsNotice } from '@/components/chat/settings-controls';
import { useChatSettingsDraft } from '@/components/chat/settings-drafts';
import { useChatColors } from '@/hooks/use-chat-colors';

const LOCAL = 'local';
const targetId = (execution: ChatExecutionSettings) =>
  execution.target.kind === 'local' ? LOCAL : execution.target.machineId;

function dismissSettings(id: ConversationId) {
  if (router.canGoBack()) router.back();
  else router.replace({ pathname: '/chats/chat/[id]', params: { id } });
}

export default function ChatSettingsScreen() {
  const colors = useChatColors();
  const { id, view, initial, settings, setSettings, execution, setExecution, cwdText } = useChatSettingsDraft();
  const { service, catalog, providerAccess, refreshCatalog, remoteHosts } = useChatApp();
  const conversation = useChatControls(view);
  const hosts = useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const savingRef = useRef(false);
  const mounted = useRef(true);
  // Each environment keeps the directory typed for it, so switching back restores it.
  const directoryDrafts = useRef(new Map([[targetId(initial.execution), initial.execution.cwd]]));
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const target = execution.target;
  const selectedHost = target.kind === 'ssh' ? hosts.hosts.find((host) => host.id === target.machineId) : undefined;
  const executionChanged = !sameExecution(execution, initial.execution);
  let executionError: string | undefined;
  try { validateExecution(execution); }
  catch (cause) { executionError = cause instanceof Error ? cause.message : String(cause); }
  if (executionChanged && target.kind === 'ssh' && !selectedHost) {
    executionError = 'Choose an available remote machine.';
  }
  const provider = catalog.find((entry) => entry.id === settings.model.provider);
  const access = providerAccess(settings.model.provider);
  const settingsError = getModelSettingsError(catalog, settings);
  const blocked = !service || !conversation;
  const disabled = blocked || saving || refreshing;
  const changed = settings.model.provider !== initial.settings.model.provider
    || settings.model.modelId !== initial.settings.model.modelId
    || settings.thinkingLevel !== initial.settings.thinkingLevel;
  const canSave = !disabled && (changed || executionChanged) && (!changed || !settingsError) && !executionError;
  const refresh = async () => {
    if (disabled) return;
    setRefreshing(true);
    setError(undefined);
    try { await refreshCatalog(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not refresh models. Try again.'); }
    finally { setRefreshing(false); }
  };
  const save = async () => {
    if (!service || !canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      if (executionChanged) await service.updateExecution(id, execution, changed ? settings : undefined);
      else await service.updateSettings(id, settings);
      if (!mounted.current) return;
      setSaving(false);
      dismissSettings(id);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : 'Could not save these settings. Try again.');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const chooseEnvironment = (value: string) => {
    if (disabled || value === targetId(execution)) return;
    directoryDrafts.current.set(targetId(execution), execution.cwd);
    const next: ChatExecutionSettings = value === LOCAL
      ? { target: { kind: 'local' }, cwd: directoryDrafts.current.get(value) ?? '/workspace' }
      : { target: { kind: 'ssh', machineId: value }, cwd: directoryDrafts.current.get(value) ?? null };
    setExecution(next);
    cwdText.set(next.cwd ?? '');
  };
  const environmentCaption = 'Remote execution uses your phone’s Tailscale VPN and the machine’s SSH server. '
    + 'Switching environments does not copy files. Remote forks share the machine’s current files.'
    + (target.kind === 'ssh'
      ? ' Choose a folder or enter an absolute path; leave it blank for the home directory.' : '');

  return <>
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Cancel" onPress={() => dismissSettings(id)} />
    </Stack.Toolbar>
    <Stack.Toolbar placement="right">
      {saving ? <Stack.Toolbar.View><ActivityIndicator /></Stack.Toolbar.View>
        : <Stack.Toolbar.Button icon="checkmark" variant="prominent" tintColor={colors.accent}
          accessibilityLabel="Save" disabled={!canSave} onPress={() => { void save(); }} />}
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="chat-settings-screen">
      <Form>
        {blocked && <SettingsNotice tone="neutral" testID="settings-locked"
          message="Chat settings will be available when this chat finishes loading." />}
        {error && <SettingsNotice testID="settings-save-error" message={error} />}
        <ModelSection title="Model" catalog={catalog} settings={settings} disabled={disabled} onChange={setSettings}
          error={settingsError && (settings.model.modelId ? settingsError
            : 'Choose a model to finish changing the provider.')}
          caption="These settings apply to the next response in this chat. Changing them keeps the conversation."
          onChooseModel={() => router.push({ pathname: '/chat-settings/[id]/model', params: { id } })} />
        {!access.connected && <SettingsNotice tone="neutral" testID="settings-connection"
          message={access.error || `Connect ${provider?.name || settings.model.provider} in Account before sending `
            + 'a message. You can save your choice now.'}
          action={saving ? undefined : 'Open account'} onAction={() => {
            if (savingRef.current) return;
            router.push({ pathname: '/account', params: { provider: settings.model.provider } });
          }} />}
        <Section title="Execution environment"
          footer={<SectionFooter error={executionError ?? hosts.error} caption={environmentCaption} />}>
          <Picker<string> label="Environment" selection={targetId(execution)} onSelectionChange={chooseEnvironment}
            modifiers={[pickerStyle('menu'), disable(disabled || !hosts.ready)]}>
            <Text modifiers={[tag(LOCAL)]}>On this device</Text>
            {target.kind === 'ssh' && !selectedHost && <Text modifiers={[tag(target.machineId)]}>
              Unavailable machine
            </Text>}
            {hosts.hosts.map((host) => <Text key={host.id} modifiers={[tag(host.id)]}>{host.name}</Text>)}
          </Picker>
          <LabeledContent label="Working directory">
            <TextField text={cwdText} placeholder={target.kind === 'ssh' ? 'Home directory' : '/workspace'}
              onTextChange={(cwd) => setExecution({ ...execution, cwd: cwd.trim() ? cwd : null })}
              modifiers={[autocorrectionDisabled(), textInputAutocapitalization('never'), disable(disabled)]} />
          </LabeledContent>
          {target.kind === 'ssh' && <Button label="Choose a folder" systemImage="folder"
            modifiers={[disable(disabled || !selectedHost)]}
            onPress={() => router.push({ pathname: '/chat-settings/[id]/directory', params: { id } })} />}
          <Button label="Manage remote machines" systemImage="server.rack" modifiers={[disable(saving)]}
            onPress={() => router.push('/remote-hosts')} />
        </Section>
        <Section footer={<Text>You can choose a different provider or model for each chat.</Text>}>
          <Button label={refreshing ? 'Refreshing models…' : 'Refresh models'} systemImage="arrow.clockwise"
            modifiers={[disable(blocked || saving || refreshing)]} onPress={() => { void refresh(); }} />
        </Section>
      </Form>
    </Host>
  </>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
