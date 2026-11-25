import {
  Button, ContentUnavailableView, Form, Host, Label, LabeledContent, Section, Text,
} from '@expo/ui/swift-ui';
import { disabled as disable, font, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { ROOT } from '@pi-agent/infinichat/pi/infinichat/agents';
import { router, Stack } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { useChatApp, useInfiniChatSecrets } from '@/chat/chat-provider';
import { SettingsNotice } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

function dismiss() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function expiresIn(expiresAt: number): string {
  const minutes = Math.max(1, Math.ceil((expiresAt - Date.now()) / 60_000));
  return `Expires in ~${minutes} min`;
}

/** Lists active ephemeral credentials held in RAM (metadata only) so the user can revoke one or all. */
export default function InfiniChatSecretsScreen() {
  const colors = useChatColors();
  const { infiniChat } = useChatApp();
  const secrets = useInfiniChatSecrets();
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string>();
  const clear = async (id?: string) => {
    if (clearing) return;
    setClearing(true);
    setError(undefined);
    try {
      await infiniChat.clearSecrets(id);
      if (id === undefined || secrets.length <= 1) dismiss();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not clear credentials.');
    } finally {
      setClearing(false);
    }
  };
  return <>
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close active credentials" onPress={dismiss} />
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="infinichat-secrets-screen">
      {secrets.length === 0 && !error ? (
        <ContentUnavailableView title="No active credentials" systemImage="lock.open"
          description={'Credentials you enter for agents stay in memory until they expire, you clear them, '
            + 'or the host restarts.'} />
      ) : (
        <Form>
          {error && <SettingsNotice testID="secrets-clear-error" message={error} />}
          {secrets.map((secret) => (
            <Section key={secret.id} title={secret.label}>
              <Label title={secret.purpose} systemImage="lock.shield"
                modifiers={[font({ textStyle: 'footnote' }), secondary]} />
              {secret.agent !== ROOT && (
                <LabeledContent label="Agent"><Text modifiers={[secondary]}>{secret.agent}</Text></LabeledContent>
              )}
              <LabeledContent label="Lifetime">
                <Text modifiers={[secondary]}>{expiresIn(secret.expiresAt)}</Text>
              </LabeledContent>
              <Button label="Clear credential" role="destructive" modifiers={[disable(clearing)]}
                onPress={() => { void clear(secret.id); }} />
            </Section>
          ))}
          <Section footer={<Text>
            Values are kept in memory only, never saved to disk or shown to the model. Clearing invalidates
            handles immediately.
          </Text>}>
            <Button label="Clear All Credentials" role="destructive" modifiers={[disable(clearing)]}
              onPress={() => { void clear(); }} />
          </Section>
        </Form>
      )}
    </Host>
  </>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
