import { createModelSettings } from '@pi-agent/infinichat/pi/model-catalog';
import { router, Stack } from 'expo-router';
import { useState } from 'react';

import { useInfiniChatAccount } from '@/chat/chat-provider';
import { ModelChoices } from '@/components/chat/settings-controls';
import { useAgentModelDraft } from '@/components/chat/settings-drafts';

/** The chosen provider's models; choosing one returns to the agent's model. */
export default function AgentModelChoicesScreen() {
  const { settings, setSettings } = useAgentModelDraft();
  const { catalog } = useInfiniChatAccount();
  const [query, setQuery] = useState('');
  const provider = catalog.find((entry) => entry.id === settings.model.provider);
  return <>
    <Stack.Screen options={{ headerSearchBarOptions: { placeholder: 'Search models',
      onChangeText: (event) => setQuery(event.nativeEvent.text) } }} />
    <ModelChoices provider={provider} selectedId={settings.model.modelId} query={query} onSelect={(model) => {
      setSettings(createModelSettings(model, settings.thinkingLevel));
      router.back();
    }} />
  </>;
}
