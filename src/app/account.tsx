import * as Location from 'expo-location';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Alert, Linking, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useChatApp } from '@/chat/chat-provider';
import { AuthPromptForm } from '@/components/chat/auth-prompt';
import { ChatIcon } from '@/components/chat/icon';
import { ActionButton, IconButton, InlineNotice, PiMark } from '@/components/chat/primitives';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { ProviderOption } from '@/pi/model-catalog';
import { OPENAI_PROVIDER_ID } from '@/pi/openai-auth/core';

function ProviderAccountCard({ provider }: { provider: ProviderOption }) {
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
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string>();
  const notice = error || access.error;
  const save = async () => {
    setSaving(true); setError(undefined);
    try { await saveProviderKey(provider.id, key); setKey(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this provider key.'); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    setRemoving(true); setError(undefined);
    try { await disconnectProvider(provider.id); setKey(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove this provider key.'); }
    finally { setRemoving(false); }
  };
  const retry = async () => {
    setRetrying(true);
    setError(undefined);
    try { await retryAuth(provider.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore this connection.'); }
    finally { setRetrying(false); }
  };
  return <View testID={`provider-account-${provider.id}`} style={[styles.connection, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.connectionHeader}>
      <View style={styles.connectionCopy}>
        <Text style={[styles.providerName, { color: colors.text }]}>{provider.name}</Text>
        <Text accessibilityLiveRegion="polite" style={[styles.providerDescription, { color: colors.secondary }]}>{!access.ready ? 'Restoring connection…'
          : access.connected ? access.type === 'oauth' ? provider.id === OPENAI_PROVIDER_ID ? 'Using ChatGPT plan' : `Connected to ${accountName}` : 'API key saved'
            : oauth ? `Use ${accountName} or an API key` : 'Connect with your API key'}</Text>
      </View>
      {access.connected && <ChatIcon name="check" size={18} color={colors.accent} />}
    </View>
    {oauth && <>
      {authStatus && <Text testID={`auth-status-${provider.id}`} accessibilityLiveRegion="polite" style={[styles.authStatus, { color: colors.secondary }]}>{authStatus}</Text>}
      {!authenticating && <ActionButton testID={`sign-in-${provider.id}`} title={access.connected && access.type === 'oauth' ? `Switch ${accountName} account` : oauth.loginLabel ?? `Continue with ${accountName}`}
        disabled={!access.ready || signingIn || saving || removing || signOutPending} onPress={() => { setKey(''); setShowKey(false); setError(undefined); void signIn(provider.id); }} />}
      {!authenticating && access.type === 'api_key' && <Text style={[styles.privacyText, { color: colors.secondary }]}>Signing in replaces the saved API key for {provider.name}.</Text>}
      {authenticating && authPrompt && <AuthPromptForm key={authPrompt.id} pending={authPrompt} submit={submitAuthPrompt}
        openBrowser={() => { void openSignInPage(); }} browserOpen={browserOpen} />}
      {authenticating && <ActionButton testID={`cancel-sign-in-${provider.id}`} title="Cancel sign-in" secondary onPress={cancelSignIn} />}
      {!authenticating && <ActionButton testID={`choose-api-key-${provider.id}`} title={showKey ? 'Hide API key entry' : 'Use API key'} secondary
        disabled={signingIn || saving || removing || signOutPending} onPress={() => { setKey(''); setShowKey((show) => !show); }} />}
    </>}
    {(!oauth || showKey) && <>
    {access.type === 'oauth' && <Text style={[styles.privacyText, { color: colors.secondary }]}>Saving an API key replaces {accountName} sign-in for {provider.name} and uses API billing.</Text>}
    <TextInput testID={`provider-key-${provider.id}`} accessibilityLabel={`${provider.name} API key`} value={key} onChangeText={setKey}
      secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete="off" textContentType="none" editable={!saving && !removing && !signingIn}
      placeholder={access.connected ? 'Enter a replacement API key' : 'Enter API key'} placeholderTextColor={colors.muted}
      style={[styles.keyInput, { color: colors.text, backgroundColor: colors.background, borderColor: colors.border }]} />
    <ActionButton testID={`save-provider-${provider.id}`} title={access.type === 'oauth' ? 'Use this API key' : access.connected ? 'Replace API key' : 'Save API key'} loading={saving}
      disabled={!key.trim() || !access.ready || removing || signingIn || signOutPending} onPress={() => { void save(); }} />
    </>}
    {notice && <InlineNotice message={notice} />}
    {access.retryable && disconnectingProvider !== provider.id && <ActionButton testID={`retry-provider-${provider.id}`}
      title="Retry connection" secondary loading={retrying} disabled={signingIn || saving || removing || signOutPending}
      onPress={() => { void retry(); }} />}
    {(access.connected || access.error || disconnectingProvider === provider.id) && <ActionButton testID={`remove-provider-${provider.id}`} title={disconnectingProvider === provider.id ? 'Retry disconnecting' : `Disconnect ${provider.name}`} secondary loading={removing}
      disabled={signingIn || saving || (signOutPending && disconnectingProvider !== provider.id)} onPress={() => { void remove(); }} />}
    <Text style={[styles.privacyText, { color: colors.muted }]}>{access.type === 'oauth'
      ? `Requests use your ${accountName} ${oauth?.isSubscription ? 'plan' : 'account'}. Each chat keeps its selected provider and model.`
      : `API key requests use your ${provider.name} API account and its billing. The provider checks your key when you send a message.`}</Text>
  </View>;
}

/** The keep-alive opt-in, with the location use explained where it is switched on (App Review 2.5.4). */
function BackgroundWorkCard() {
  const colors = useChatColors();
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
          'Pi Agent holds a background location stream to keep agent work running while your phone is locked. '
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
  return <View style={[styles.connection, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.connectionHeader}>
      <View style={styles.connectionCopy}>
        <Text style={[styles.providerName, { color: colors.text }]}>Background work</Text>
        <Text style={[styles.privacyText, { color: colors.secondary }]}>
          Keep agent work running while your phone is locked. Pi Agent holds a background location stream to stay
          alive — your location is never read, stored, or sent anywhere — and shows progress in a Live Activity.
          Off by default.
        </Text>
      </View>
      <Switch testID="keep-alive-toggle" value={enabled} disabled={asking} onValueChange={(value) => { void change(value); }} />
    </View>
  </View>;
}

export default function AccountScreen() {
  const colors = useChatColors();
  const insets = useSafeAreaInsets();
  const { provider: requestedProvider } = useLocalSearchParams<{ provider?: string }>();
  const { catalog, hasConnectedProvider, cancelSignIn } = useChatApp();
  const focusedProvider = catalog.find((provider) => provider.id === (requestedProvider ?? OPENAI_PROVIDER_ID));
  useEffect(() => () => cancelSignIn(), [cancelSignIn]);
  return <View testID="account-screen" style={[styles.screen, { backgroundColor: colors.background }]}>
    <Stack.Screen options={{ title: 'Providers', headerRight: () => <IconButton testID="close-account" icon="close" label="Close providers" onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }} /> }} />
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
      <View style={styles.hero}>
        <PiMark size={64} />
        <Text style={[styles.title, { color: colors.text }]}>Your providers.</Text>
        <Text style={[styles.subtitle, { color: colors.secondary }]}>Connect accounts here, then choose a provider, model, and reasoning effort in each chat.</Text>
      </View>
      <View style={[styles.connection, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.providerName, { color: colors.text }]}>Execution environments</Text>
        <Text style={[styles.privacyText, { color: colors.secondary }]}>Configure remote machines using SSH over Tailscale, then choose an environment in each chat’s settings.</Text>
        <ActionButton testID="manage-remote-hosts" title="Remote machines" secondary onPress={() => router.push('/remote-hosts')} />
      </View>
      {focusedProvider && <ProviderAccountCard key={focusedProvider.id} provider={focusedProvider} />}
      {catalog.filter((provider) => provider.id !== focusedProvider?.id).map((provider) =>
        <ProviderAccountCard key={provider.id} provider={provider} />)}
      <BackgroundWorkCard />
      <View style={styles.privacy}>
        <ChatIcon name="phone" color={colors.muted} size={19} />
        <View style={styles.privacyCopy}>
          <Text style={[styles.privacyTitle, { color: colors.secondary }]}>At home on your device</Text>
          <Text style={[styles.privacyText, { color: colors.muted }]}>
            Your chat history is saved on this device, including when you sign out. Your sign-in is saved in the
            device’s secure credential storage and restored after restarting the app. Signing out removes the saved
            credentials.
          </Text>
          <Text style={[styles.privacyText, { color: colors.muted }]}>Your messages are processed by the provider selected for that chat. API keys use the same secure storage as your saved sign-in.</Text>
        </View>
      </View>
      {hasConnectedProvider && <ActionButton testID="back-to-chats" title="Back to your chats" onPress={() => { if (router.canGoBack()) router.back(); else router.replace('/'); }} />}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 24, maxWidth: 620, width: '100%', alignSelf: 'center', gap: 27 },
  hero: { alignItems: 'center', gap: 19, paddingVertical: 18 },
  title: { fontSize: 29, lineHeight: 36, textAlign: 'center', letterSpacing: -0.8, fontWeight: '500' },
  subtitle: { fontSize: 14, lineHeight: 22, textAlign: 'center' },
  connection: { borderRadius: 23, borderWidth: StyleSheet.hairlineWidth, padding: 19, gap: 19 },
  connectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  connectionCopy: { flex: 1, gap: 4 },
  providerName: { fontSize: 17, fontWeight: '600' },
  providerDescription: { fontSize: 12 },
  authStatus: { fontSize: 13, lineHeight: 20 },
  keyInput: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, minHeight: 48, fontSize: 14 },
  privacy: { flexDirection: 'row', gap: 12, paddingHorizontal: 5 },
  privacyCopy: { flex: 1, gap: 7 },
  privacyTitle: { fontSize: 13, fontWeight: '500' },
  privacyText: { fontSize: 12, lineHeight: 19 },
});
