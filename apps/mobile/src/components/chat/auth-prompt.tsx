import { Button, SecureField, Text, TextField, VStack, useNativeState } from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled, disabled as disable, font, foregroundStyle, onSubmit, textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import type { PendingAuthPrompt } from '@pi-agent/infinichat/chat/auth-prompt-controller';
import { useState } from 'react';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const MANUAL_INSTRUCTIONS = 'Finish sign-in in your browser, then copy the full address of the final callback page '
  + 'and paste it below, even if that page does not load. Keep this screen open until sign-in finishes.';

/** A sign-in step as form rows. Key it by pending.id so answers never survive a step change or cancelled login. */
export function AuthPromptRows({ pending, submit, openBrowser, browserOpen }: {
  pending: PendingAuthPrompt;
  submit(id: number, value: string): boolean;
  openBrowser?: () => void;
  browserOpen: boolean;
}) {
  const text = useNativeState('');
  const [answer, setAnswer] = useState('');
  const { prompt, id } = pending;
  const manual = prompt.type === 'manual_code';
  const send = (value: string) => {
    if (!value.trim() || !submit(id, value)) return;
    setAnswer('');
    text.set('');
  };
  const fieldModifiers = [autocorrectionDisabled(), textInputAutocapitalization('never'), onSubmit(() => send(answer))];
  return <>
    <Text modifiers={[secondary]}>{manual ? MANUAL_INSTRUCTIONS : prompt.message}</Text>
    {manual && openBrowser && <Button label="Open in browser" systemImage="safari" onPress={openBrowser}
      modifiers={[disable(browserOpen)]} />}
    {prompt.type === 'select' ? prompt.options.map((option) => <Button key={option.id} onPress={() => send(option.id)}>
      <VStack alignment="leading" spacing={2}>
        <Text>{option.label}</Text>
        {option.description ? <Text modifiers={[font({ textStyle: 'footnote' }), secondary]}>
          {option.description}
        </Text> : null}
      </VStack>
    </Button>) : <>
      {manual || prompt.type === 'secret'
        ? <SecureField text={text} placeholder={manual ? 'Paste the full callback URL' : prompt.placeholder}
          onTextChange={setAnswer} modifiers={fieldModifiers} />
        : <TextField text={text} placeholder={prompt.placeholder}
          onTextChange={setAnswer} modifiers={fieldModifiers} />}
      <Button label="Continue" onPress={() => send(answer)} modifiers={[disable(!answer.trim())]} />
    </>}
  </>;
}
