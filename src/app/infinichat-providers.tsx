import { Form, Host, Label, Section, Text } from '@expo/ui/swift-ui';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';

import { useInfiniChatAccount } from '@/chat/chat-provider';
import { ProviderSections } from '@/components/chat/provider-section';
import { useChatColors } from '@/hooks/use-chat-colors';

/** The providers of the machine InfiniChat runs on, signed in from this iPhone and kept on that machine. */
export default function InfiniChatProvidersScreen() {
  const colors = useChatColors();
  const { provider: requestedProvider } = useLocalSearchParams<{ provider?: string }>();
  const account = useInfiniChatAccount();
  const { catalog, cancelSignIn, machine } = account;
  // As the account screen does: leaving ends the sign-in this screen shows.
  useEffect(() => () => cancelSignIn(), [cancelSignIn]);
  return <>
    <Stack.Screen options={{ title: machine === undefined ? 'Providers' : `Providers on ${machine}` }} />
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close providers"
        onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }} />
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="infinichat-providers-screen">
      <Form>
        <ProviderSections catalog={catalog} focus={requestedProvider} account={account} />
        <Section footer={<Text>
          {`InfiniChat on ${machine ?? 'this machine'} uses these sign-ins and API keys. They are saved on that `
            + 'machine, readable only by your account there, and renewed there. This iPhone’s own sign-in, which '
            + 'your other chats use, stays separate.'}
        </Text>}>
          <Label title={`Saved on ${machine ?? 'the machine'}`} systemImage="server.rack" />
        </Section>
      </Form>
    </Host>
  </>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
