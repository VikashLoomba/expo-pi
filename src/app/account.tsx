import { Form, Host, Label, Section, Text, Toggle } from '@expo/ui/swift-ui';
import { disabled as disable } from '@expo/ui/swift-ui/modifiers';
import * as Location from 'expo-location';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Linking, StyleSheet } from 'react-native';

import { useChatApp } from '@/chat/chat-provider';
import { ProviderSections } from '@/components/chat/provider-section';
import { PushRow } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';

const PRIVACY = 'Your chat history is saved on this device, including when you sign out. Your sign-in is saved in the '
  + 'device’s secure credential storage and restored after restarting the app; signing out removes it. Your messages '
  + 'are processed by the provider selected for that chat. API keys use the same secure storage as your sign-in.';

/** The keep-alive opt-in, with the location use explained where it is switched on (App Review 2.5.4). */
function BackgroundWorkSection() {
  const { keepAliveSettings } = useChatApp();
  const enabled = useSyncExternalStore(keepAliveSettings.subscribe, keepAliveSettings.getSnapshot,
    keepAliveSettings.getSnapshot);
  const [asking, setAsking] = useState(false);
  const change = async (value: boolean) => {
    if (!value) {
      keepAliveSettings.setEnabled(false);
      return;
    }
    setAsking(true);
    try {
      const permission = await Location.requestBackgroundPermissionsAsync();
      if (permission.status !== 'granted') {
        Alert.alert('Allow location access to keep work running',
          'InfiniChat holds a background location stream to keep agent work running while your phone is locked. '
          + 'Your location is never read, stored, or sent anywhere. Allow “Always” location access to use this.',
          [{ text: 'Not now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => { void Linking.openSettings(); } }]);
        return;
      }
      keepAliveSettings.setEnabled(true);
    } finally {
      setAsking(false);
    }
  };
  return <Section title="Background work" footer={<Text>
    Keep agent work running while your phone is locked. InfiniChat holds a background location stream to stay alive —
    your location is never read, stored, or sent anywhere — and shows progress in a Live Activity. Off by default.
  </Text>}>
    <Toggle label="Keep work running when locked" isOn={enabled} modifiers={[disable(asking)]}
      onIsOnChange={(value) => { void change(value); }} />
  </Section>;
}

export default function AccountScreen() {
  const colors = useChatColors();
  const { provider: requestedProvider } = useLocalSearchParams<{ provider?: string }>();
  const account = useChatApp();
  const { catalog, cancelSignIn } = account;
  useEffect(() => () => cancelSignIn(), [cancelSignIn]);
  return <>
    <Stack.Screen options={{ title: 'Providers' }} />
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close providers"
        onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }} />
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="account-screen">
      <Form>
        <ProviderSections catalog={catalog} focus={requestedProvider} account={account} />
        <Section title="Execution environments" footer={<Text>
          Configure remote machines using SSH over Tailscale, then choose an environment in each chat’s settings.
        </Text>}>
          <PushRow label="Remote machines" onPress={() => router.push('/remote-hosts')} />
        </Section>
        <BackgroundWorkSection />
        <Section footer={<Text>{PRIVACY}</Text>}>
          <Label title="Your chats stay on this device" systemImage="iphone" />
        </Section>
      </Form>
    </Host>
  </>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
