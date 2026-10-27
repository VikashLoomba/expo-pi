import type { SshConnection } from '@osuki-dev/react-native-ssh';

import { BootstrapError } from './bootstrap-errors';
import { runSshCommand } from './command-channel';
import { isSshKeyBlob, type RemoteHost, type RemoteHostRepository } from './hosts';
import { quotePosix } from './provisioning';

/** What a machine's key exchange found: its own key, and the others' keys now in its `authorized_keys`. */
export interface MachineKeys { publicKey: string; authorizedKeys: readonly string[] }

/** How a connection learns the keys to authorize on its machine, and keeps what the exchange found. */
export interface KeyExchange {
  others(): readonly string[];
  store(keys: MachineKeys): Promise<void>;
}

/** The key's type and base64, as `authorized_keys` matches it, without the comment `ssh-keygen` appends. */
const blob = (line: string) => line.trim().split(/\s+/).slice(0, 2).join(' ');

/**
 * Gives the machine its own InfiniChat SSH key, with which its InfiniChat server reaches the other machines
 * (`packages/infinichat/src/node/machines.ts`), and authorizes the other machines' keys there as `ssh-copy-id` does:
 * `~/.ssh/authorized_keys` gets each key it lacks. The private key never leaves the machine; this phone keeps public
 * keys only. Run at every connection, it changes nothing the second time.
 */
export async function exchangeKeys(connection: SshConnection, others: readonly string[],
  options: { signal: AbortSignal; token: string }): Promise<MachineKeys> {
  const marker = `PI-SSH-KEYS ${options.token}`;
  const authorized = others.map(blob).filter(isSshKeyBlob);
  const lines = [
    'set -eu', 'umask 077',
    'd="$HOME/.infinichat/ssh"', 'k="$d/id_ed25519"', 'mkdir -p "$d"',
    `[ -f "$k" ] || ssh-keygen -q -t ed25519 -N '' -C infinichat -f "$k"`,
    'mkdir -p "$HOME/.ssh"', 'chmod 700 "$HOME/.ssh"',
    'a="$HOME/.ssh/authorized_keys"', '[ -e "$a" ] || : > "$a"',
    // A file the account can read but not write, as one made with sudo, is replaced in its own `.ssh` by a copy it
    // owns; sshd reads the same lines. One it can't read is reported instead.
    'if [ ! -w "$a" ]; then',
    '  if [ -r "$a" ] && cp "$a" "$a.infinichat" && mv -f "$a.infinichat" "$a"; then :; else',
    `    printf '%s\\n' ${quotePosix(`${marker} unwritable`)}; exit 0; fi`,
    'fi',
    'chmod 600 "$a"',
    ...authorized.map((key) =>
      `grep -qF -- ${quotePosix(key)} "$a" || printf '%s\\n' ${quotePosix(`${key} infinichat`)} >> "$a"`),
    `printf '%s\\n' ${quotePosix(`${marker} ok`)}`, 'cat "$k.pub"',
  ];
  const response = await runSshCommand(connection, `sh -c ${quotePosix(lines.join('\n'))}`,
    { signal: options.signal });
  const output = response.stdout.split(/\r?\n/);
  const start = output.findLastIndex((line) => line.startsWith(`${marker} `));
  const status = start < 0 ? '' : output[start].slice(marker.length + 1);
  if (response.exitCode === 0 && status === 'unwritable') throw new BootstrapError('AUTHORIZED_KEYS');
  const publicKey = start < 0 ? '' : blob(output[start + 1] ?? '');
  if (response.exitCode !== 0 || status !== 'ok' || !isSshKeyBlob(publicKey)) throw new BootstrapError('SSH_KEYS');
  return { publicKey, authorizedKeys: authorized };
}

/** The exchange for `host`: the other machines' keys this phone knows, kept on the machine's record. */
export function machineKeyExchange(hosts: RemoteHostRepository, host: RemoteHost): KeyExchange {
  return {
    others: () => hosts.getSnapshot().hosts.flatMap((other) =>
      other.id !== host.id && other.publicKey !== undefined ? [other.publicKey] : []),
    store: async (keys) => { await hosts.setKeys(host, keys); },
  };
}
