import { router, Stack, usePreventRemove } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatApp, useChatControls, useChatError, useChatStatus, useInfiniChatView } from '@/chat/chat-provider';
import { ActionButton, InlineNotice } from '@/components/chat/primitives';
import {
  HeaderAction, ModelSettingRows, SettingsChoices, modelChoices, type ModelPicker, type SettingsChoice,
} from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { InfiniChatView } from '@/pi/infinichat-view';
import {
  createModelSettings, findCatalogModel, getModelSettingsError, type ChatModelSettings,
} from '@/pi/model-catalog';

/** The main model answers and works; the summary model writes the memory's summaries in the background. */
type Role = 'main' | 'summary';
type Draft = Record<Role, ChatModelSettings>;
type Picker = { role: Role; page: ModelPicker };

const TITLE = 'InfiniChat settings';
const roleNames: Record<Role, string> = { main: 'the main model', summary: 'the summary model' };
const pageTitles: Record<ModelPicker, string> = { provider: 'Provider', model: 'Model', effort: 'Reasoning effort' };
/** OptChat has no default model; an unchosen one is shown as such until the user picks it. */
const unchosen: ChatModelSettings = { model: { provider: '', modelId: '' }, thinkingLevel: 'off' };

const sameSettings = (left: ChatModelSettings, right: ChatModelSettings) => left.model.provider === right.model.provider
  && left.model.modelId === right.model.modelId && left.thinkingLevel === right.thinkingLevel;

function dismissSettings() {
  if (router.canGoBack()) router.back();
  else router.replace('/infinichat');
}

export default function InfiniChatSettingsRoute() {
  const colors = useChatColors();
  const { infiniChat, error: appError } = useChatApp();
  const view = useInfiniChatView();
  const conversation = useChatControls(view);
  const status = useChatStatus(view);
  const viewError = useChatError(view);
  if (!conversation) return <View style={[styles.loading, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: TITLE,
      headerLeft: () => <HeaderAction title="Cancel" onPress={dismissSettings} /> }} />
    {(!infiniChat || status === 'loading') && !appError ? <ActivityIndicator color={colors.accent} />
      : <InlineNotice message={viewError || appError || 'InfiniChat is not available.'} />}
  </View>;
  // Draft state belongs to this editor session; incoming snapshots do not overwrite choices before the user saves
  // or cancels.
  return <InfiniChatSettingsEditor view={view}
    initial={{ main: conversation.settings, summary: conversation.summary ?? unchosen }} />;
}

function InfiniChatSettingsEditor({ view, initial }: { view: InfiniChatView | undefined; initial: Draft }) {
  const colors = useChatColors();
  const insets = useSafeAreaInsets();
  const { infiniChat: service, catalog, providerAccess, refreshCatalog } = useChatApp();
  const conversation = useChatControls(view);
  const [draft, setDraft] = useState<Draft>(initial);
  const [picker, setPicker] = useState<Picker>();
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const choosePage = (next?: Picker) => {
    setSearch('');
    setPicker(next);
    setError(undefined);
  };
  const disableRemovalPrevention = usePreventRemove(saving || !!picker, () => {
    if (!saving && picker) choosePage();
  });
  const blocked = !service || !conversation;
  const disabled = blocked || saving || refreshing;
  const changed = !sameSettings(draft.main, initial.main) || !sameSettings(draft.summary, initial.summary);
  const errors: Record<Role, string | undefined> = {
    main: getModelSettingsError(catalog, draft.main), summary: getModelSettingsError(catalog, draft.summary),
  };
  const canSave = !disabled && changed && !errors.main && !errors.summary;
  const providerName = (providerId: string) => catalog.find((entry) => entry.id === providerId)?.name || providerId;
  // A chosen provider that is not connected yet; both choices can still be saved.
  const unconnected = [...new Set([draft.main.model.provider, draft.summary.model.provider])]
    .filter((providerId) => providerId && !providerAccess(providerId).connected);
  const choose = (role: Role, settings: ChatModelSettings) => {
    setDraft((current) => role === 'main' ? { ...current, main: settings } : { ...current, summary: settings });
  };
  const refresh = async () => {
    if (disabled) return;
    setRefreshing(true);
    setError(undefined);
    try {
      await refreshCatalog();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not refresh models. Try again.');
    } finally {
      setRefreshing(false);
    }
  };
  const save = async () => {
    if (!service || !canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      // One commit: the main model with pi-durable's `configure`, and the summary model in OptChat's ConfigDoc.
      await service.updateSettings(draft.main, draft.summary);
      if (!mounted.current) return;
      setSaving(false);
      disableRemovalPrevention();
      dismissSettings();
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : 'Could not save these settings. Try again.');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const select = (value: string) => {
    if (!picker || disabled) return;
    const { role, page } = picker;
    const current = draft[role];
    if (page === 'provider') {
      if (value !== current.model.provider) {
        choose(role, { model: { provider: value, modelId: '' }, thinkingLevel: current.thinkingLevel });
      }
      choosePage({ role, page: 'model' });
      return;
    }
    if (page === 'model') {
      const model = catalog.find((entry) => entry.id === current.model.provider)?.models
        .find((entry) => entry.id === value);
      if (!model) return;
      choose(role, createModelSettings(model, current.thinkingLevel));
      choosePage();
      return;
    }
    const thinkingLevel = findCatalogModel(catalog, current.model)?.thinkingLevels.find((level) => level === value);
    if (thinkingLevel) choose(role, { ...current, thinkingLevel });
    choosePage();
  };
  const query = search.trim().toLocaleLowerCase();
  const matches = (choice: SettingsChoice) =>
    `${choice.title} ${choice.description || ''}`.toLocaleLowerCase().includes(query);
  const shown = picker && { ...picker, settings: draft[picker.role] };
  const choices = shown ? modelChoices(catalog, shown.settings, shown.page).filter(matches) : [];
  const selectedId = !shown ? '' : shown.page === 'provider' ? shown.settings.model.provider
    : shown.page === 'model' ? shown.settings.model.modelId : shown.settings.thinkingLevel;
  const description = !shown ? ''
    : shown.page === 'provider' ? `Choose the provider for ${roleNames[shown.role]}.`
      : shown.page === 'model' ? `Choose ${roleNames[shown.role]} from ${providerName(shown.settings.model.provider)}.`
        : 'Higher effort can take longer. The available levels depend on this model.';
  // A provider that was never chosen needs no notice: its row asks for one.
  const choiceError = (role: Role) => !draft[role].model.provider ? undefined
    : draft[role].model.modelId ? errors[role] : 'Choose a model to finish changing the provider.';
  const mainError = choiceError('main');
  const summaryError = choiceError('summary');
  const group = [styles.group, { backgroundColor: colors.surface, borderColor: colors.border }];

  return <View testID="infinichat-settings-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: picker ? pageTitles[picker.page] : TITLE, gestureEnabled: !saving,
      headerBackVisible: false,
      headerLeft: () => <HeaderAction testID={picker ? 'infinichat-settings-back' : 'cancel-infinichat-settings'}
        title={picker ? 'Back' : 'Cancel'} disabled={saving} onPress={() => {
          if (picker) choosePage();
          else dismissSettings();
        }} />,
      headerRight: () => !picker ? <HeaderAction testID="save-infinichat-settings" title="Save" disabled={!canSave}
        loading={saving} onPress={() => { void save(); }} /> : null,
    }} />
    {picker ? <SettingsChoices choices={choices} selectedId={selectedId} disabled={disabled}
      bottomInset={insets.bottom} search={search} onSearch={picker.page === 'effort' ? undefined : setSearch}
      searchPlaceholder={picker.page === 'provider' ? 'Search providers' : 'Search models'} description={description}
      onSelect={select} />
    : <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
      <View style={styles.intro}>
        <Text style={[styles.title, { color: colors.text }]}>InfiniChat</Text>
        <Text style={[styles.description, { color: colors.secondary }]}>
          The main model answers you. The summary model condenses the chat into the memory each answer starts from.
          InfiniChat sends and summarizes nothing until both are chosen.
        </Text>
      </View>
      {blocked && <InlineNotice tone="neutral" testID="infinichat-settings-locked"
        message="InfiniChat settings will be available when InfiniChat finishes loading." />}
      {error && <InlineNotice testID="infinichat-settings-save-error" message={error} />}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.secondary }]}>MAIN MODEL</Text>
        <View style={group}>
          <ModelSettingRows testID="infinichat-main" catalog={catalog} settings={draft.main} disabled={disabled}
            onOpen={(page) => choosePage({ role: 'main', page })} />
        </View>
        {mainError && <InlineNotice testID="infinichat-main-unavailable" message={mainError} />}
      </View>
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.secondary }]}>SUMMARY MODEL</Text>
        <View style={group}>
          <ModelSettingRows testID="infinichat-summary" catalog={catalog} settings={draft.summary} disabled={disabled}
            onOpen={(page) => choosePage({ role: 'summary', page })} />
        </View>
        {summaryError && <InlineNotice testID="infinichat-summary-unavailable" message={summaryError} />}
        <Text style={[styles.caption, { color: colors.muted }]}>
          Summaries run in the background after every message, so a fast, inexpensive model suits them.
        </Text>
      </View>
      {unconnected.map((providerId) => <InlineNotice key={providerId} tone="neutral"
        testID={`infinichat-settings-connection-${providerId}`}
        message={providerAccess(providerId).error
          || `Connect ${providerName(providerId)} in Account before InfiniChat can use it. `
            + 'You can save your choice now.'}
        action={saving ? undefined : 'Open account'} onAction={() => {
          if (!savingRef.current) router.push({ pathname: '/account', params: { provider: providerId } });
        }} />)}
      <ActionButton testID="refresh-infinichat-models" title="Refresh models" secondary icon="retry"
        loading={refreshing} disabled={blocked || saving} onPress={() => { void refresh(); }} />
      <Text style={[styles.caption, { color: colors.muted }]}>
        InfiniChat runs each command on this phone or on one of your remote machines, choosing for each command.
        Changing models keeps InfiniChat’s memory and history.
      </Text>
    </ScrollView>}
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', padding: 20, gap: 20 },
  intro: { gap: 8, paddingTop: 6 },
  title: { fontSize: 22, fontWeight: '600' },
  description: { fontSize: 14, lineHeight: 22 },
  section: { gap: 10 },
  sectionTitle: { fontSize: 10, fontWeight: '600', letterSpacing: 1.1, paddingHorizontal: 3 },
  group: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, overflow: 'hidden' },
  caption: { fontSize: 12, lineHeight: 19, paddingHorizontal: 3 },
});
