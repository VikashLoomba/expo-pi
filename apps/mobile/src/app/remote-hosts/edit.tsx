import {
  Form, Host, HStack, LabeledContent, Picker, ProgressView, SecureField, Section, Text, TextField, useNativeState,
} from '@expo/ui/swift-ui';
import {
  autocorrectionDisabled, disabled as disable, font, foregroundStyle, keyboardType, lineLimit, pickerStyle, tag,
  textInputAutocapitalization,
} from '@expo/ui/swift-ui/modifiers';
import { router, Stack, useLocalSearchParams, useNavigation, usePreventRemove } from 'expo-router';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActionSheetIOS, ActivityIndicator, StyleSheet } from 'react-native';

import { useChatApp } from '@/chat/chat-provider';
import { SettingsNotice } from '@/components/chat/settings-controls';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { RemoteCredential, RemoteHost } from '@/pi/execution/remote/hosts';
import { setupStageLabels, testRemoteHost } from '@/pi/execution/remote/test-host';

const plainText = [autocorrectionDisabled(), textInputAutocapitalization('never')];
const FIELDS = ['name', 'hostname', 'port', 'username', 'password', 'privateKey', 'passphrase'] as const;
type Field = (typeof FIELDS)[number];
const secondary = foregroundStyle({ type: 'hierarchical', style: 'secondary' });

/** Adds a machine, or edits the one named by `id`; saving connects to it, then returns to where it was opened from. */
export default function RemoteHostEditScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const colors = useChatColors();
  const { remoteHosts } = useChatApp();
  const snapshot = useSyncExternalStore(remoteHosts.subscribe, remoteHosts.getSnapshot, remoteHosts.getSnapshot);
  const host = id === undefined ? undefined : snapshot.hosts.find((entry) => entry.id === id);
  if (id !== undefined && !host) {
    return <Host style={styles.fill} seedColor={colors.accent}>
      <Form>
        <SettingsNotice message={snapshot.ready ? 'This machine was removed.' : 'Loading saved machines…'}
          tone={snapshot.ready ? 'error' : 'neutral'} />
      </Form>
    </Host>;
  }
  return <MachineForm key={host?.id ?? 'new'} host={host} />;
}

function MachineForm({ host }: { host?: RemoteHost }) {
  const colors = useChatColors();
  const { remoteHosts } = useChatApp();
  // The record this form edits: the one it opened with, or the one Add saved before a connection that failed.
  const [saved, setSaved] = useState(host);
  const [credentialType, setCredentialType] = useState<RemoteCredential['type']>(host?.credentialType ?? 'password');
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  // The connection a save runs, which leaving the form stops; the record stays.
  const connecting = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => connecting.current?.abort(), []);
  const initial = { name: host?.name ?? '', hostname: host?.hostname ?? '', port: String(host?.port ?? 22),
    username: host?.username ?? '', password: '', privateKey: '', passphrase: '' };
  // The fields' latest text, read when saving.
  const fields = useRef(initial);
  // Presented alone from the InfiniChat menu, the sheet has no Back button, so Cancel on the leading edge dismisses
  // it; pushed from the list, Back does (HIG Sheets: never Cancel, Back and Done together).
  const navigation = useNavigation();
  const firstInSheet = (navigation.getState()?.index ?? 0) === 0;
  // Unsaved changes get an action sheet before the sheet closes, whether by Cancel, Back or a swipe (HIG Sheets).
  const [dirty, setDirty] = useState(false);
  const unsaved = (type: RemoteCredential['type']) => type !== (host?.credentialType ?? 'password')
    || FIELDS.some((field) => fields.current[field] !== initial[field]);
  const edit = (field: Field, value: string) => {
    fields.current[field] = value;
    setDirty(unsaved(credentialType));
  };
  const disablePrevention = usePreventRemove(dirty, ({ repeat }) => {
    ActionSheetIOS.showActionSheetWithOptions(
      { options: ['Discard Changes', 'Keep Editing'], destructiveButtonIndex: 0, cancelButtonIndex: 1 },
      (button) => {
        if (button !== 0) return;
        setDirty(false);
        repeat();
      });
  });
  const nameText = useNativeState(initial.name);
  const hostnameText = useNativeState(initial.hostname);
  const portText = useNativeState(initial.port);
  const usernameText = useNativeState(initial.username);
  const passwordText = useNativeState('');
  const privateKeyText = useNativeState('');
  const passphraseText = useNativeState('');
  const chooseCredential = (value: string) => {
    const next = value === 'privateKey' ? 'privateKey' : 'password';
    if (next === credentialType) return;
    // Only the chosen credential is kept, so switching clears the other one.
    fields.current.password = '';
    fields.current.privateKey = '';
    fields.current.passphrase = '';
    passwordText.set('');
    privateKeyText.set('');
    passphraseText.set('');
    setCredentialType(next);
    setDirty(unsaved(next));
  };
  const save = async () => {
    const { name, hostname, port, username, password, privateKey, passphrase } = fields.current;
    setSaving(true);
    setError(undefined);
    const controller = new AbortController();
    connecting.current = controller;
    try {
      let replacement: RemoteCredential | undefined;
      if (credentialType === 'password' && password) replacement = { type: 'password', password };
      if (credentialType === 'privateKey' && privateKey.trim()) {
        replacement = passphrase ? { type: 'privateKey', privateKey, passphrase } : { type: 'privateKey', privateKey };
      }
      if ((!saved || credentialType !== saved.credentialType) && !replacement) {
        throw new Error('Enter the selected SSH credential.');
      }
      if (!/^\d+$/.test(port.trim())) throw new Error('SSH port must be a number from 1 to 65535.');
      const record = await remoteHosts.save({ ...(saved ? { id: saved.id } : {}), name, hostname, port: Number(port),
        username }, replacement, saved);
      setSaved(record);
      setDirty(false);
      disablePrevention();
      // Saved, the machine connects at once: its SSH host key is trusted on first use, remote execution is prepared
      // and the InfiniChat keys are exchanged, so it is ready wherever machines are chosen.
      setProgress('Connecting through Tailscale…');
      await testRemoteHost(remoteHosts, record.id, { signal: controller.signal,
        onProgress: (stage) => setProgress(setupStageLabels[stage]) });
      if (controller.signal.aborted) return;
      router.back();
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : 'Could not save this machine.');
    } finally {
      if (connecting.current === controller) connecting.current = undefined;
      setSaving(false);
      setProgress(undefined);
    }
  };
  return <>
    <Stack.Screen options={{ title: host ? 'Edit machine' : 'Add machine' }} />
    {firstInSheet && <Stack.Toolbar placement="left">
      <Stack.Toolbar.Button icon="xmark" accessibilityLabel="Cancel" onPress={() => router.back()} />
    </Stack.Toolbar>}
    <Stack.Toolbar placement="right">
      {saving ? <Stack.Toolbar.View><ActivityIndicator /></Stack.Toolbar.View>
        : <Stack.Toolbar.Button icon="checkmark" variant="prominent" tintColor={colors.accent}
          accessibilityLabel={host ? 'Save machine' : 'Add machine'} onPress={() => { void save(); }} />}
    </Stack.Toolbar>
    <Host style={styles.fill} seedColor={colors.accent} testID="remote-host-form">
      <Form>
        {error && <SettingsNotice testID="remote-host-save-error" message={error} />}
        {progress !== undefined && <Section>
          <HStack spacing={10}>
            <ProgressView />
            <Text modifiers={[secondary]}>{progress}</Text>
          </HStack>
        </Section>}
        <Section title="Machine" footer={<Text>
          Use the full MagicDNS name when available. Both devices must already be connected to Tailscale.
        </Text>}>
          <LabeledContent label="Name">
            <TextField text={nameText} placeholder="My Mac" modifiers={[disable(saving)]}
              onTextChange={(value) => edit('name', value)} />
          </LabeledContent>
          <LabeledContent label="Hostname">
            <TextField text={hostnameText} placeholder="machine.tailnet.ts.net"
              modifiers={[...plainText, keyboardType('url'), disable(saving)]}
              onTextChange={(value) => edit('hostname', value)} />
          </LabeledContent>
          <LabeledContent label="Port">
            <TextField text={portText} placeholder="22" modifiers={[keyboardType('numeric'), disable(saving)]}
              onTextChange={(value) => edit('port', value)} />
          </LabeledContent>
          <LabeledContent label="Username">
            <TextField text={usernameText} placeholder="Remote account" modifiers={[...plainText, disable(saving)]}
              onTextChange={(value) => edit('username', value)} />
          </LabeledContent>
        </Section>
        <Section title="SSH authentication" footer={<Text>
          {'Credentials and trusted SSH keys stay in this device’s secure storage. Saving connects to the machine, '
            + 'trusts its SSH host key on first use and prepares it for InfiniChat.'
            + (saved ? ' Changes apply to later sessions; work already admitted keeps its configuration.' : '')}
        </Text>}>
          <Picker<string> selection={credentialType} onSelectionChange={chooseCredential}
            modifiers={[pickerStyle('segmented'), disable(saving)]}>
            <Text modifiers={[tag('password')]}>Password</Text>
            <Text modifiers={[tag('privateKey')]}>Private key</Text>
          </Picker>
          {credentialType === 'password'
            ? <SecureField text={passwordText} modifiers={[disable(saving)]}
              placeholder={saved ? 'Leave blank to keep the saved password' : 'SSH account password'}
              onTextChange={(value) => edit('password', value)} />
            : <>
              <TextField text={privateKeyText} axis="vertical"
                placeholder={saved ? 'Leave blank to keep the saved key' : 'Paste your complete private key'}
                modifiers={[...plainText, font({ design: 'monospaced', textStyle: 'footnote' }),
                  lineLimit({ min: 4, max: 10 }), disable(saving)]}
                onTextChange={(value) => edit('privateKey', value)} />
              <SecureField text={passphraseText} placeholder="Passphrase (optional)" modifiers={[disable(saving)]}
                onTextChange={(value) => edit('passphrase', value)} />
            </>}
        </Section>
      </Form>
    </Host>
  </>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
