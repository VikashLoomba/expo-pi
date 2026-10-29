import type { SshConnection } from '@automatalabs/react-native-ssh';
import { isSshKeyBlob, keyBlob, keyExchangeLines } from '@pi-agent/infinichat/pi/infinichat-remote/keys';

import { otherKeys, type MachinesAccess } from '../../infinichat-remote/phone-machines';
import { BootstrapError } from './bootstrap-errors';
import { runSshCommand } from './command-channel';
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

/** The exchange for the machine at `endpoint`: the others' keys as the document has them, and its keys kept there. */
export function machineKeyExchange(machines: MachinesAccess, endpoint: string): KeyExchange {
  return {
    others: () => otherKeys(machines, endpoint),
    store: (keys) => machines.patch(endpoint,
      { publicKey: keys.publicKey, authorizedKeys: [...keys.authorizedKeys].sort() }),
  };
}
