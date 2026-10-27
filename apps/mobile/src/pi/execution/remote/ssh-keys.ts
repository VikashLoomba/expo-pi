import type { SshConnection } from '@osuki-dev/react-native-ssh';
import { isSshKeyBlob, keyBlob, keyExchangeLines } from '@pi-agent/infinichat/pi/infinichat-remote/keys';

import { BootstrapError } from './bootstrap-errors';
import { runSshCommand } from './command-channel';
import type { RemoteHost, RemoteHostRepository } from './hosts';
import { quotePosix } from './provisioning';

/** What a machine's key exchange found: its own key, and the others' keys now in its `authorized_keys`. */
export interface MachineKeys { publicKey: string; authorizedKeys: readonly string[] }

/** How a connection learns the keys to authorize on its machine, and keeps what the exchange found. */
export interface KeyExchange {
  others(): readonly string[];
  store(keys: MachineKeys): Promise<void>;
}

/**
 * Runs the key exchange on the machine (the package's `keys.ts`): its own InfiniChat key, and the other machines'
 * keys into its `authorized_keys`. The private key never leaves the machine; this phone keeps public keys only.
 */
export async function exchangeKeys(connection: SshConnection, others: readonly string[],
  options: { signal: AbortSignal; token: string }): Promise<MachineKeys> {
  const marker = `PI-SSH-KEYS ${options.token}`;
  const authorized = others.map(keyBlob).filter(isSshKeyBlob);
  const lines = ['set -eu', ...keyExchangeLines(authorized, `printf '%s\\n' ${quotePosix(marker)}`)];
  const response = await runSshCommand(connection, `sh -c ${quotePosix(lines.join('\n'))}`,
    { signal: options.signal });
  const output = response.stdout.split(/\r?\n/);
  const start = output.lastIndexOf(marker);
  const answer: string[] = start < 0 ? [] : output.slice(start + 1, start + 3);
  const status = answer[0];
  if (response.exitCode === 0 && status === 'unwritable') throw new BootstrapError('AUTHORIZED_KEYS');
  const publicKey = keyBlob(answer[1] ?? '');
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
