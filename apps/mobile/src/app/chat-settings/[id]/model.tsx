import { router, Stack } from 'expo-router';
import { useState } from 'react';

import { useChatApp } from '@/chat/chat-provider';
import { ModelChoices } from '@/components/chat/settings-controls';
import { useChatSettingsDraft } from '@/components/chat/settings-drafts';
import { createModelSettings } from '@/pi/model-catalog';

/** The chosen provider's models; choosing one returns to the chat settings. */
export default function ChatModelScreen() {
  const { settings, setSettings } = useChatSettingsDraft();
  const { catalog } = useChatApp();
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
