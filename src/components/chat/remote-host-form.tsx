import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { ActionButton, InlineNotice } from '@/components/chat/primitives';
import { useChatColors } from '@/hooks/use-chat-colors';
import type { RemoteCredential, RemoteHost, RemoteHostInput } from '@/pi/execution/remote/hosts';

export function RemoteHostForm({ host, onSave, onCancel }: {
  host?: RemoteHost;
  onSave: (input: RemoteHostInput, credential?: RemoteCredential) => Promise<void>;
  onCancel: () => void;
}) {
  const colors = useChatColors();
  const [name, setName] = useState(host?.name ?? '');
  const [hostname, setHostname] = useState(host?.hostname ?? '');
  const [port, setPort] = useState(String(host?.port ?? 22));
  const [username, setUsername] = useState(host?.username ?? '');
  const [credentialType, setCredentialType] = useState<RemoteCredential['type']>(host?.credentialType ?? 'password');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    setSaving(true); setError(undefined);
    try {
      const replacement = credentialType === 'password' ? password ? { type: 'password' as const, password } : undefined
        : privateKey.trim() ? { type: 'privateKey' as const, privateKey, ...(passphrase ? { passphrase } : {}) } : undefined;
      if ((!host || credentialType !== host.credentialType) && !replacement) throw new Error('Enter the selected SSH credential.');
      if (!/^\d+$/.test(port.trim())) throw new Error('SSH port must be a number from 1 to 65535.');
      await onSave({ ...(host ? { id: host.id } : {}), name, hostname, port: Number(port), username }, replacement);
      setPassword(''); setPrivateKey(''); setPassphrase('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this machine.'); }
    finally { setSaving(false); }
  };
  const field = (id: string, label: string, value: string, onChangeText: (text: string) => void, placeholder: string,
    options: { secret?: boolean; multiline?: boolean; numeric?: boolean } = {}) => <View style={styles.field} key={id}>
    <Text style={[styles.label, { color: colors.secondary }]}>{label}</Text>
    <TextInput testID={`remote-host-${id}`} accessibilityLabel={label} value={value} onChangeText={onChangeText}
      placeholder={placeholder} placeholderTextColor={colors.muted} editable={!saving} autoCorrect={false} autoCapitalize="none"
      autoComplete="off" textContentType="none" secureTextEntry={options.secret} multiline={options.multiline}
      keyboardType={options.numeric ? 'number-pad' : 'default'}
      style={[styles.input, options.multiline && styles.multiline, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]} />
  </View>;
  return <View testID="remote-host-form" style={styles.form}>
    <Text style={[styles.title, { color: colors.text }]}>{host ? 'Edit machine' : 'Add a remote machine'}</Text>
    {field('name', 'Machine name', name, setName, 'My Mac')}
    {field('hostname', 'Tailscale hostname or address', hostname, setHostname, 'machine.tailnet.ts.net')}
    <Text style={[styles.detail, { color: colors.secondary }]}>Use the full MagicDNS name when available. Both devices must already be connected to Tailscale.</Text>
    {field('port', 'SSH port', port, setPort, '22', { numeric: true })}
    {field('username', 'SSH username', username, setUsername, 'Your remote account')}
    <Text style={[styles.label, { color: colors.secondary }]}>SSH authentication</Text>
    <View style={styles.authentication}>
      <ActionButton testID="remote-host-password-method" title="Password" secondary={credentialType !== 'password'} disabled={saving}
        onPress={() => { setCredentialType('password'); setPrivateKey(''); setPassphrase(''); }} />
      <ActionButton testID="remote-host-key-method" title="Private key" secondary={credentialType !== 'privateKey'} disabled={saving}
        onPress={() => { setCredentialType('privateKey'); setPassword(''); }} />
    </View>
    {credentialType === 'password'
      ? field('password', host ? 'Replacement SSH password' : 'SSH password', password, setPassword, host ? 'Leave blank to keep the saved password' : 'SSH account password', { secret: true })
      : <>
        {field('private-key', host ? 'Replacement SSH private key' : 'SSH private key', privateKey, setPrivateKey,
          host ? 'Leave blank to keep the saved key' : 'Paste your complete private key', { multiline: true })}
        {field('passphrase', 'Private key passphrase (optional)', passphrase, setPassphrase, 'Passphrase for the replacement key', { secret: true })}
      </>}
    <Text style={[styles.detail, { color: colors.secondary }]}>Credentials and accepted SSH keys stay in this device’s secure storage. Save, then test the connection to verify the server and prepare it for remote execution.</Text>
    {host && <Text style={[styles.detail, { color: colors.secondary }]}>Changes apply to subsequent sessions. Work already admitted keeps the previous machine configuration.</Text>}
    {error && <InlineNotice testID="remote-host-save-error" message={error} />}
    <ActionButton testID="remote-host-save" title="Save machine" loading={saving} onPress={() => { void save(); }} />
    <ActionButton testID="remote-host-cancel-edit" title="Cancel" secondary disabled={saving} onPress={onCancel} />
  </View>;
}

const styles = StyleSheet.create({
  form: { gap: 16 }, title: { fontSize: 22, fontWeight: '600' }, field: { gap: 8 }, label: { fontSize: 13, fontWeight: '500' },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, minHeight: 48, padding: 13, fontSize: 15 },
  multiline: { minHeight: 120, maxHeight: 240, textAlignVertical: 'top', fontSize: 12 },
  detail: { fontSize: 13, lineHeight: 20 }, authentication: { flexDirection: 'row', gap: 10 },
});
