import { spawn } from 'node:child_process';

import { sshArguments, type SshTarget } from '@earendil-works/pi-env';
import type { TailscaleLogins } from '@pi-agent/infinichat/pi/infinichat-remote/tailscale';

/**
 * Touches the machine with one `ssh … true` whose stderr is watched as it comes, before pi-env's own connections,
 * which read stderr only once `ssh` has exited and give up after a minute: the sign-in opens while `ssh` waits for
 * it, and the touch ends once it went through. Resolves however the touch ends; what it could not do, pi-env's
 * connection says in its own terms (an unknown or changed host key, a refused login).
 */
export function touchOverSsh(target: SshTarget, logins: TailscaleLogins, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('ssh', [...sshArguments(target), 'true'], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', (chunk: Buffer | string) => logins.watch(chunk.toString()));
    const end = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    child.once('exit', end);
    child.once('error', end);
  });
}
