import {
  Button, Form, Host, HStack, RNHostView, Section, Text, TextField, useNativeState,
} from '@expo/ui/swift-ui';
import { disabled as disable, lineLimit } from '@expo/ui/swift-ui/modifiers';
import { getModelSettingsError, type ChatModelSettings } from '@pi-agent/infinichat/pi/model-catalog';
import { router, Stack } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import ImagePlayground from 'torch-image-playground';

import { useChatApp, useChatControls, useInfiniChatAccount } from '@/chat/chat-provider';
import { AgentMark, ChatAgentContext } from '@/components/chat/agent';
import { ModelSection, SettingsNotice } from '@/components/chat/settings-controls';
import {
  useInfiniChatSettingsDraft, type InfiniChatRole,
} from '@/components/chat/settings-drafts';
import { useChatColors } from '@/hooks/use-chat-colors';

const roles: readonly InfiniChatRole[] = ['main', 'summary'];
const roleTitles: Record<InfiniChatRole, string> = { main: 'Main model', summary: 'Summary model' };
const roleCaptions: Record<InfiniChatRole, string> = {
  main: 'The main model answers you. InfiniChat sends and summarizes nothing until both models are chosen.',
  summary: 'The summary model condenses the chat into the memory each answer starts from. Summaries run in the '
    + 'background after every message, so a fast, inexpensive model suits them.',
};
/** How UniiChat's prompt.txt describes the user's own instructions, which follow the prompt. */
const INSTRUCTIONS_PLACEHOLDER = 'Who you are, how your files are organized and how you want work done.';
const DEFAULT_NAME = 'InfiniChat';

const sameSettings = (left: ChatModelSettings, right: ChatModelSettings) => left.model.provider === right.model.provider
  && left.model.modelId === right.model.modelId && left.thinkingLevel === right.thinkingLevel;

function dismissSettings() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

export default function InfiniChatSettingsScreen() {
  const colors = useChatColors();
  const { view, initial, draft, setDraft } = useInfiniChatSettingsDraft();
  const { infiniChat: service, infiniChatAvatar, refreshCatalog } = useChatApp();
  const { catalog, providerAccess, machine } = useInfiniChatAccount();
  const conversation = useChatControls(view);
  const instructions = useNativeState(draft.instructions);
  const name = useNativeState(draft.name);
  // Image Playground needs Apple Intelligence, which the user can turn off.
  const [playground] = useState(() => ImagePlayground.isSupported());
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const savingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const blocked = !conversation;
  const disabled = blocked || saving || refreshing;
  const settingsChanged = !sameSettings(draft.main, initial.main) || !sameSettings(draft.summary, initial.summary)
    || draft.instructions !== initial.instructions || draft.name !== initial.name;
  const avatarChanged = draft.avatar !== initial.avatar;
  const errors: Record<InfiniChatRole, string | undefined> = {
    main: getModelSettingsError(catalog, draft.main), summary: getModelSettingsError(catalog, draft.summary),
  };
  // The avatar is this phone's alone, so a new one saves without the conversation's settings.
  const canSave = !disabled && (avatarChanged || settingsChanged)
    && (!settingsChanged || (!errors.main && !errors.summary));
  const providerName = (providerId: string) => catalog.find((entry) => entry.id === providerId)?.name || providerId;
  // A chosen provider that is not connected yet; both choices can still be saved.
  const unconnected = [...new Set([draft.main.model.provider, draft.summary.model.provider])]
    .filter((providerId) => providerId && !providerAccess(providerId).connected);
  // A provider that was never chosen needs no notice: its row asks for one.
  const choiceError = (role: InfiniChatRole) => !draft[role].model.provider ? undefined
    : draft[role].model.modelId ? errors[role] : 'Choose a model to finish changing the provider.';
  const choose = (role: InfiniChatRole, settings: ChatModelSettings) => {
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
  const createAvatar = async () => {
    setError(undefined);
    try {
      // Image Playground's file is temporary; Save copies it into the app's documents.
      const path = await ImagePlayground.launchAsync();
      const avatar = path === null ? undefined : encodeURI(`file://${path}`);
      if (avatar && mounted.current) setDraft((current) => ({ ...current, avatar }));
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : 'Image Playground could not make an avatar. Try again.');
    }
  };
  const save = async () => {
    if (!canSave || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(undefined);
    try {
      // One commit: the main model and the instructions with pi-durable's `configure`, and the summary model and
      // the name in OptChat's ConfigDoc.
      if (settingsChanged) {
        await service.updateSettings({ main: draft.main, summary: draft.summary,
          instructions: draft.instructions.trim(), name: draft.name.trim() });
      }
      if (avatarChanged) {
        if (draft.avatar) infiniChatAvatar.set(draft.avatar);
        else infiniChatAvatar.clear();
      }
      if (!mounted.current) return;
      setSaving(false);
      dismissSettings();
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : 'Could not save these settings. Try again.');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  return <>
    <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Cancel" onPress={dismissSettings} />
    </Stack.Toolbar>
    <Stack.Toolbar placement="right">
      {saving ? <Stack.Toolbar.View><ActivityIndicator /></Stack.Toolbar.View>
        : <Stack.Toolbar.Button icon="checkmark" variant="prominent" tintColor={colors.accent}
          accessibilityLabel="Save" disabled={!canSave} onPress={() => { void save(); }} />}
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="infinichat-settings-screen">
      <Form>
        {blocked && <SettingsNotice tone="neutral" testID="infinichat-settings-locked"
          message="InfiniChat settings will be available when InfiniChat finishes loading." />}
        {error && <SettingsNotice testID="infinichat-settings-save-error" message={error} />}
        <Section title="Name and avatar" footer={<Text>
          {'It goes by this name in the chat and in its own instructions. The avatar stays on this iPhone.'
            + (playground ? '' : ' Making one needs Image Playground, which needs Apple Intelligence.')}
        </Text>}>
          <HStack spacing={14}>
            <RNHostView matchContents>
              <ChatAgentContext value={{ name: draft.name.trim() || DEFAULT_NAME, avatar: draft.avatar }}>
                <AgentMark size={56} />
              </ChatAgentContext>
            </RNHostView>
            <TextField text={name} placeholder={DEFAULT_NAME}
              onTextChange={(text) => setDraft((current) => ({ ...current, name: text }))}
              modifiers={[disable(disabled)]} />
          </HStack>
          <Button label={draft.avatar ? 'New Avatar with Image Playground' : 'Make an Avatar with Image Playground'}
            systemImage="apple.image.playground" modifiers={[disable(disabled || !playground)]}
            onPress={() => { void createAvatar(); }} />
          {draft.avatar && <Button label="Remove Avatar" systemImage="trash" role="destructive"
            modifiers={[disable(disabled)]}
            onPress={() => setDraft((current) => ({ ...current, avatar: undefined }))} />}
        </Section>
        {roles.map((role) => <ModelSection key={role} title={roleTitles[role]} catalog={catalog}
          settings={draft[role]} disabled={disabled} error={choiceError(role)} caption={roleCaptions[role]}
          onChange={(settings) => choose(role, settings)}
          onChooseModel={() => router.push({ pathname: '/infinichat-settings/model', params: { role } })} />)}
        {unconnected.map((providerId) => <SettingsNotice key={providerId} tone="neutral"
          testID={`infinichat-settings-connection-${providerId}`}
          message={providerAccess(providerId).error || (machine === undefined
            ? `Connect ${providerName(providerId)} in Account before InfiniChat can use it. `
            : `Sign in to ${providerName(providerId)} on ${machine} before InfiniChat can use it. `)
              + 'You can save your choice now.'}
          action={saving ? undefined : machine === undefined ? 'Open account' : `Sign in on ${machine}`}
          onAction={() => {
            if (savingRef.current) return;
            router.push({ pathname: machine === undefined ? '/account' : '/infinichat-providers',
              params: { provider: providerId } });
          }} />)}
        <Section title="Instructions" footer={<Text>
          InfiniChat runs each command on this phone or on one of your remote machines, choosing for each command.
        </Text>}>
          <TextField text={instructions} placeholder={INSTRUCTIONS_PLACEHOLDER} axis="vertical"
            onTextChange={(text) => setDraft((current) => ({ ...current, instructions: text }))}
            modifiers={[lineLimit({ min: 4, max: 12 }), disable(disabled)]} />
        </Section>
        <Section footer={<Text>Changing models keeps InfiniChat’s memory and history.</Text>}>
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
