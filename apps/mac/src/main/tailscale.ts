import { spawn } from 'node:child_process';

import { sshArguments, type SshTarget } from '@earendil-works/pi-env';
import { Utils } from 'electrobun/main';

/**
 * Tailscale SSH's check mode sends the sign-in it wants as an SSH auth banner, which `ssh` prints to stderr before
 * authentication and then waits (tailscale `ssh/tailssh/tailssh.go`, `HoldAndDelegate`); the person signs in with
 * the URL in a browser, and the waiting connection goes on. A check holds for the tailnet's check period, 12 hours by
 * default, so one sign-in covers every connection the app makes meanwhile.
 */
const LOGIN_URL = /https:\/\/login\.tailscale\.com\/[^\s'"<>]+/;

/** The sign-in URL in a piece of `ssh` output, if any. */
export const tailscaleLogin = (text: string): string | undefined => LOGIN_URL.exec(text)?.[0];

/** Opens each sign-in URL in the default browser once, and says so. */
export class TailscaleLogins {
  private readonly opened = new Set<string>();

  constructor(private readonly onOpened: (url: string) => void) {}

  /** Watches a stream of `ssh` diagnostics for the sign-in. */
  watch(text: string): void {
    const url = tailscaleLogin(text);
    if (url === undefined || this.opened.has(url)) return;
    this.opened.add(url);
    this.onOpened(url);
    Utils.openExternal(url);
  }
}

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
