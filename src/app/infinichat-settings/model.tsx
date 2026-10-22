import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { useInfiniChatAccount } from '@/chat/chat-provider';
import { ModelChoices } from '@/components/chat/settings-controls';
import { useInfiniChatSettingsDraft, type InfiniChatRole } from '@/components/chat/settings-drafts';
import { createModelSettings } from '@/pi/model-catalog';

/** One InfiniChat model's provider's models; choosing one returns to InfiniChat's settings. */
export default function InfiniChatModelScreen() {
  const params = useLocalSearchParams<{ role?: string }>();
  const role: InfiniChatRole = params.role === 'summary' ? 'summary' : 'main';
  const { draft, setDraft } = useInfiniChatSettingsDraft();
  const { catalog } = useInfiniChatAccount();
  const [query, setQuery] = useState('');
  const settings = draft[role];
  const provider = catalog.find((entry) => entry.id === settings.model.provider);
  return <>
    <Stack.Screen options={{ title: role === 'main' ? 'Main model' : 'Summary model',
      headerSearchBarOptions: { placeholder: 'Search models',
        onChangeText: (event) => setQuery(event.nativeEvent.text) } }} />
    <ModelChoices provider={provider} selectedId={settings.model.modelId} query={query} onSelect={(model) => {
      const next = createModelSettings(model, settings.thinkingLevel);
      setDraft((current) => role === 'main' ? { ...current, main: next } : { ...current, summary: next });
      router.back();
    }} />
  </>;
}
