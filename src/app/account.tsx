import { Button, Form, Host, HStack, Image, Label, LabeledContent, SecureField, Section, Text, Toggle,
  useNativeState } from '@expo/ui/swift-ui';
import { disabled as disable, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import * as Location from 'expo-location';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Alert, Linking, StyleSheet } from 'react-native';

import { useChatApp } from '@/chat/chat-provider';
import { AuthPromptRows } from '@/components/chat/auth-prompt';
import { PushRow } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { ProviderOption } from '@/pi/model-catalog';
import { OPENAI_PROVIDER_ID } from '@/pi/openai-auth/core';

const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const PRIVACY = 'Your chat history is saved on this device, including when you sign out. Your sign-in is saved in the '
  + 'device’s secure credential storage and restored after restarting the app; signing out removes it. Your messages '
  + 'are processed by the provider selected for that chat. API keys use the same secure storage as your sign-in.';

function ProviderSection({ provider }: { provider: ProviderOption }) {
  const colors = useChatColors();
  const { providerAccess, providerOAuth, saveProviderKey, disconnectProvider, retryAuth, signOutPending,
    disconnectingProvider, signingIn, signingInProvider, signIn, cancelSignIn, authNotice, authPrompt, submitAuthPrompt,
    openSignInPage, browserOpen } = useChatApp();
  const access = providerAccess(provider.id);
  const oauth = providerOAuth(provider.id);
  const accountName = provider.id === OPENAI_PROVIDER_ID ? 'ChatGPT' : oauth?.name ?? provider.name;
  const authenticating = signingInProvider === provider.id;
  const authStatus = authNotice?.providerId === provider.id ? authNotice.message : undefined;
  const [showKey, setShowKey] = useState(false);
  const keyText = useNativeState('');
  // The key field's latest text; `hasKey` only decides whether the save button is enabled.
  const key = useRef('');
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string>();
  const notice = error || access.error;
  const clearKey = () => {
    key.current = '';
    keyText.set('');
    setHasKey(false);
  };
  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      await saveProviderKey(provider.id, key.current);
      clearKey();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save this provider key.');
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    setRemoving(true);
    setError(undefined);
    try {
      await disconnectProvider(provider.id);
      clearKey();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove this provider key.');
    } finally {
      setRemoving(false);
    }
  };
  const retry = async () => {
    setRetrying(true);
    setError(undefined);
    try { await retryAuth(provider.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore this connection.'); }
    finally { setRetrying(false); }
  };
  const status = !access.ready ? 'Restoring connection…'
    : access.connected ? access.type === 'oauth'
      ? provider.id === OPENAI_PROVIDER_ID ? 'Using ChatGPT plan' : `Connected to ${accountName}`
      : 'API key saved'
      : 'Not connected';
  const footer = [
    oauth && !authenticating && access.type === 'api_key'
      ? `Signing in replaces the saved API key for ${provider.name}.` : undefined,
    showKey && access.type === 'oauth'
      ? `Saving an API key replaces ${accountName} sign-in for ${provider.name} and uses API billing.` : undefined,
    access.type === 'oauth'
      ? `Requests use your ${accountName} ${oauth?.isSubscription ? 'plan' : 'account'}. `
        + 'Each chat keeps its selected provider and model.'
      : `API key requests use your ${provider.name} API account and its billing. `
        + 'The provider checks your key when you send a message.',
  ].filter(Boolean).join(' ');
  const busy = signingIn || saving || removing || signOutPending;
  return <Section title={provider.name} footer={<Text>{footer}</Text>}>
    <LabeledContent label="Status">
      <HStack spacing={6}>
        <Text modifiers={[secondary]}>{status}</Text>
        {access.connected && <Image systemName="checkmark.circle.fill" size={16} color={colors.accent} />}
      </HStack>
    </LabeledContent>
    {oauth && authStatus && <Text modifiers={[secondary]}>{authStatus}</Text>}
    {oauth && !authenticating && <Button modifiers={[disable(!access.ready || busy)]}
      label={access.connected && access.type === 'oauth' ? `Switch ${accountName} account`
        : oauth.loginLabel ?? `Continue with ${accountName}`}
      onPress={() => {
        clearKey();
        setShowKey(false);
        setError(undefined);
        void signIn(provider.id);
      }} />}
    {oauth && authenticating && authPrompt && <AuthPromptRows key={authPrompt.id} pending={authPrompt}
      submit={submitAuthPrompt} openBrowser={() => { void openSignInPage(); }} browserOpen={browserOpen} />}
    {oauth && authenticating && <Button label="Cancel sign-in" onPress={cancelSignIn} />}
    {oauth && !authenticating && <Button label={showKey ? 'Hide API key entry' : 'Use API key'}
      modifiers={[disable(busy)]} onPress={() => {
        clearKey();
        setShowKey((show) => !show);
      }} />}
    {(!oauth || showKey) && <>
      <SecureField text={keyText} placeholder={access.connected ? 'Enter a replacement API key' : 'Enter API key'}
        onTextChange={(value) => {
          key.current = value;
          setHasKey(!!value.trim());
        }} modifiers={[disable(saving || removing || signingIn)]} />
      <Button modifiers={[disable(!hasKey || !access.ready || busy)]}
        label={saving ? 'Saving…' : access.type === 'oauth' ? 'Use this API key'
          : access.connected ? 'Replace API key' : 'Save API key'}
        onPress={() => { void save(); }} />
    </>}
    {notice && <Label title={notice} systemImage="exclamationmark.circle"
      modifiers={[foregroundStyle(colors.danger)]} />}
    {access.retryable && disconnectingProvider !== provider.id && <Button
      label={retrying ? 'Retrying…' : 'Retry connection'} modifiers={[disable(retrying || busy)]}
      onPress={() => { void retry(); }} />}
    {(access.connected || access.error || disconnectingProvider === provider.id) && <Button role="destructive"
      label={disconnectingProvider === provider.id ? 'Retry disconnecting' : `Disconnect ${provider.name}`}
      modifiers={[disable(removing || signingIn || saving
        || (signOutPending && disconnectingProvider !== provider.id))]}
      onPress={() => { void remove(); }} />}
  </Section>;
}

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
  const { catalog, cancelSignIn } = useChatApp();
  const focused = catalog.find((provider) => provider.id === (requestedProvider ?? OPENAI_PROVIDER_ID));
  const providers = focused ? [focused, ...catalog.filter((provider) => provider.id !== focused.id)] : catalog;
  useEffect(() => () => cancelSignIn(), [cancelSignIn]);
  return <>
    <Stack.Screen options={{ title: 'Providers' }} />
    <Stack.Toolbar placement="right">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Close providers"
        onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }} />
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="account-screen">
      <Form>
        {providers.map((provider) => <ProviderSection key={provider.id} provider={provider} />)}
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
