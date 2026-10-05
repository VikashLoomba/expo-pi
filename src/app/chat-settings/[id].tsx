import { router, Stack, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatApp, useChatConversationState } from '@/chat/chat-provider';
import { ActionButton, InlineNotice } from '@/components/chat/primitives';
import { SettingRow, SettingsChoices, thinkingLevelLabel, type SettingsChoice } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';
import { createModelSettings, findCatalogModel, getModelSettingsError, type ChatModelSettings, type ModelThinkingLevel } from '@/pi/model-catalog';

type Picker = 'provider' | 'model' | 'effort';

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
  return <ChatSettingsEditor key={id} id={id} initialSettings={conversation.settings} />;
}

function ChatSettingsEditor({ id, initialSettings }: { id: string; initialSettings: ChatModelSettings }) {
  const colors = useChatColors();
  const insets = useSafeAreaInsets();
  const { ready, catalog, providerAccess, refreshCatalog } = useChatApp();
  const { conversation, updateSettings } = useChatConversationState(id);
  const [draft, setDraft] = useState<ChatModelSettings>(initialSettings);
  const [picker, setPicker] = useState<Picker>();
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const savingRef = useRef(false);
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
  const canSave = !disabled && changed && !settingsError;
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
      await updateSettings(draft);
      setSaving(false);
      disableRemovalPrevention();
      dismissSettings(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save these settings. Try again.');
    } finally {
      savingRef.current = false;
      setSaving(false);
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
  const choices: SettingsChoice[] = picker === 'provider'
    ? catalog.map((entry) => ({ id: entry.id, title: entry.name, description: entry.models.length ? `${entry.models.length} ${entry.models.length === 1 ? 'model' : 'models'}` : 'No models available', disabled: entry.models.length === 0 })).filter(matches)
    : picker === 'model'
      ? (provider?.models ?? []).map((entry) => ({ id: entry.id, title: entry.name, description: `${entry.id} · ${entry.reasoning ? 'Reasoning available' : 'No reasoning control'}` })).filter(matches)
      : (model?.thinkingLevels ?? []).map((level) => ({ id: level, title: thinkingLevelLabel(level) }));
  const selectedId = picker === 'provider' ? draft.model.provider : picker === 'model' ? draft.model.modelId : draft.thinkingLevel;
  const title = picker === 'provider' ? 'Provider' : picker === 'model' ? 'Model' : picker === 'effort' ? 'Reasoning effort' : 'Chat settings';

  return <View testID="chat-settings-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title, gestureEnabled: !saving, headerBackVisible: false,
      headerLeft: () => <HeaderAction testID={picker ? 'settings-back' : 'cancel-chat-settings'} title={picker ? 'Back' : 'Cancel'} disabled={saving}
        onPress={() => { if (picker) choosePage(); else dismissSettings(id); }} />,
      headerRight: () => !picker ? <HeaderAction testID="save-chat-settings" title="Save" disabled={!canSave} loading={saving} onPress={() => { void save(); }} /> : null,
    }} />
    {picker ? <SettingsChoices choices={choices} selectedId={selectedId} disabled={disabled} bottomInset={insets.bottom}
      search={search} onSearch={picker === 'effort' ? undefined : setSearch} searchPlaceholder={picker === 'provider' ? 'Search providers' : 'Search models'}
      description={picker === 'provider' ? 'Choose the provider for this chat.' : picker === 'model' ? `Choose a model from ${provider?.name || draft.model.provider}.` : 'Higher effort can take longer. The available levels depend on this model.'}
      onSelect={(value) => {
        if (picker === 'provider') selectProvider(value);
        else if (picker === 'model') selectModel(value);
        else { setDraft({ ...draft, thinkingLevel: value as ModelThinkingLevel }); choosePage(); }
      }} /> : <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
      <View style={styles.intro}>
        <Text style={[styles.chatTitle, { color: colors.text }]}>{conversation?.title || 'New chat'}</Text>
        <Text style={[styles.description, { color: colors.secondary }]}>These settings apply to the next response in this chat and are saved on this device.</Text>
      </View>
      {blocked && <InlineNotice tone="neutral" testID="settings-locked" message={conversation?.pending || conversation?.busy ? 'Finish or stop the current response before changing settings.' : 'Chat settings will be available when this chat finishes loading.'} />}
      {error && <InlineNotice testID="settings-save-error" message={error} />}
      {settingsError && <InlineNotice testID="settings-unavailable" message={draft.model.modelId ? settingsError : 'Choose a model to finish changing the provider.'} />}
      <View style={[styles.group, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <SettingRow testID="settings-provider" label="Provider" value={provider?.name || draft.model.provider} disabled={disabled} onPress={() => choosePage('provider')} />
        <SettingRow testID="settings-model" label="Model" value={model?.name || draft.model.modelId || 'Choose a model'}
          detail={model && model.id !== model.name ? model.id : undefined} disabled={disabled || !provider?.models.length} onPress={() => choosePage('model')} />
        <SettingRow testID="settings-effort" label="Reasoning effort" value={thinkingLevelLabel(draft.thinkingLevel)}
          detail={!model ? 'Choose an available model first.' : !model.reasoning ? 'This model does not support reasoning.' : model.thinkingLevels.length === 1 ? 'This model uses a fixed reasoning level.' : undefined}
          disabled={disabled || !canChooseEffort} onPress={() => choosePage('effort')} />
      </View>
      {!access.connected && <InlineNotice tone="neutral" testID="settings-connection" message={access.error || `Connect ${provider?.name || draft.model.provider} in Account before sending a message. You can save your choice now.`}
        action="Open account" onAction={() => router.push({ pathname: '/account', params: { provider: draft.model.provider } })} />}
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
  headerAction: { minHeight: 44, minWidth: 48, justifyContent: 'center', alignItems: 'center' },
  headerLabel: { fontSize: 16, fontWeight: '500' },
});
