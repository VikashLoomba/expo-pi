import { Form, Host } from '@expo/ui/swift-ui';
import { getModelSettingsError } from '@pi-agent/infinichat/pi/model-catalog';
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { useChatApp, useInfiniChatAccount } from '@/chat/chat-provider';
import { ModelSection, SettingsNotice } from '@/components/chat/settings-controls';
import { useAgentModelDraft } from '@/components/chat/settings-drafts';
import { useChatColors } from '@/hooks/use-chat-colors';

function dismiss() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** The model and reasoning effort one agent runs on, as a chat's settings choose a chat's. */
export default function AgentModelScreen() {
  const colors = useChatColors();
  const { name, initial, settings, setSettings } = useAgentModelDraft();
  const { infiniChat } = useChatApp();
  const { catalog, providerAccess, machine } = useInfiniChatAccount();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const provider = catalog.find((entry) => entry.id === settings.model.provider);
  const access = providerAccess(settings.model.provider);
  const settingsError = getModelSettingsError(catalog, settings);
  const changed = settings.model.provider !== initial.model.provider
    || settings.model.modelId !== initial.model.modelId || settings.thinkingLevel !== initial.thinkingLevel;
  const canSave = !saving && changed && !settingsError;
  const save = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      await infiniChat.agent(name).setModel(settings);
      if (mounted.current) dismiss();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not save this model. Try again.');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return <>
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Cancel" onPress={dismiss} />
    </Stack.Toolbar>
    <Stack.Toolbar placement="right">
      {saving ? <Stack.Toolbar.View><ActivityIndicator /></Stack.Toolbar.View>
        : <Stack.Toolbar.Button icon="checkmark" variant="prominent" tintColor={colors.accent}
          accessibilityLabel="Save" disabled={!canSave} onPress={() => { void save(); }} />}
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="agent-model-screen">
      <Form>
        {error && <SettingsNotice testID="agent-model-save-error" message={error} />}
        <ModelSection title="Model" catalog={catalog} settings={settings} disabled={saving} onChange={setSettings}
          error={!settings.model.provider ? undefined
            : settings.model.modelId ? settingsError : 'Choose a model to finish changing the provider.'}
          caption={`${name} runs on this model from its next response. Changing it keeps its memory.`}
          onChooseModel={() => router.push({ pathname: '/infinichat-agent/[name]/model', params: { name } })} />
        {!!settings.model.provider && !access.connected && <SettingsNotice tone="neutral"
          testID="agent-model-connection"
          message={access.error || (machine === undefined
            ? `Connect ${provider?.name || settings.model.provider} in Account before ${name} can use it. `
            : `Sign in to ${provider?.name || settings.model.provider} on ${machine} before ${name} can use it. `)
              + 'You can save your choice now.'} />}
      </Form>
    </Host>
  </>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
