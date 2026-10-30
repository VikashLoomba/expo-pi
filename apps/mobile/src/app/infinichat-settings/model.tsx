import { createModelSettings } from '@pi-agent/infinichat/pi/model-catalog';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { useInfiniChatAccount } from '@/chat/chat-provider';
import { ModelChoices } from '@/components/chat/settings-controls';
import {
  roleSettings, useInfiniChatSettingsDraft, withRoleSettings, type InfiniChatRole,
} from '@/components/chat/settings-drafts';

const titles: Record<InfiniChatRole, string> = {
  main: 'Main model', summary: 'Summary model', subagents: 'Subagent model',
};

/** One InfiniChat model's provider's models; choosing one returns to InfiniChat's settings. */
export default function InfiniChatModelScreen() {
  const params = useLocalSearchParams<{ role?: string }>();
  const role: InfiniChatRole = params.role === 'summary' || params.role === 'subagents' ? params.role : 'main';
  const { draft, setDraft } = useInfiniChatSettingsDraft();
  const { catalog } = useInfiniChatAccount();
  const [query, setQuery] = useState('');
  const settings = roleSettings(draft, role);
  const provider = catalog.find((entry) => entry.id === settings.model.provider);
  return <>
    <Stack.Screen options={{ title: titles[role],
      headerSearchBarOptions: { placeholder: 'Search models',
        onChangeText: (event) => setQuery(event.nativeEvent.text) } }} />
    <ModelChoices provider={provider} selectedId={settings.model.modelId} query={query} onSelect={(model) => {
      const next = createModelSettings(model, settings.thinkingLevel);
      setDraft((current) => withRoleSettings(current, role, next));
      router.back();
    }} />
  </>;
}
