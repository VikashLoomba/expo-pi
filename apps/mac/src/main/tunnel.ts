import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server, type Socket } from 'node:net';

import { sshArguments, type SshTarget } from '@earendil-works/pi-env';

/** A loopback port on this Mac that reaches a port on a machine's loopback, through this Mac's own `ssh`. */
export interface Tunnel {
  readonly port: number;
  /** A connection through the tunnel ended on its own: the `ssh` behind it exited. */
  onDropped(listener: () => void): void;
  close(): Promise<void>;
}

/**
 * The Mac's counterpart of the phone's second SSH connection and `forwardLocal` (`phone-dialer.ts`): pi-env carries
 * requests and files, not sockets, so each connection to the local port is one `ssh -W 127.0.0.1:<port>` whose
 * stdio is the socket (OpenSSH's stdio forwarding, which `ClearAllForwardings` leaves alone), under pi-env's own
 * arguments: batch mode, no agent, host keys from the app's file. A connection ends when its `ssh` exits.
 */
export function openTunnel(target: SshTarget, port: number): Promise<Tunnel> {
  const children = new Set<ChildProcess>();
  const dropped = new Set<() => void>();
  let closing = false;
  const server: Server = createServer((socket: Socket) => {
    // pi-env's arguments end with `--` and the host; the forwarding goes before them.
    const base = sshArguments(target);
    const child = spawn('ssh', [...base.slice(0, -2), '-W', `127.0.0.1:${port}`, ...base.slice(-2)],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child);
    let diagnostics = '';
    child.stderr?.on('data', (chunk: Buffer | string) => { diagnostics += chunk.toString(); });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
    const end = () => {
      children.delete(child);
      socket.destroy();
      if (closing) return;
      if (diagnostics.trim()) console.error(`ssh to ${target.host} ended: ${diagnostics.trim().split('\n').at(-1)}`);
      for (const listener of [...dropped]) listener();
    };
    child.once('exit', end);
    child.once('error', end);
    socket.once('close', () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`Unexpected tunnel address ${address}.`));
        return;
      }
      resolve({
        port: address.port,
        onDropped: (listener) => { dropped.add(listener); },
        close: () => new Promise((done) => {
          closing = true;
          for (const child of children) child.kill();
          server.close(() => done());
        }),
      });
    });
  });
}
