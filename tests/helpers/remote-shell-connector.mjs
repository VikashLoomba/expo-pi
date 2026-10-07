import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const shellHostKey = {
  algorithm: 'ssh-ed25519', fingerprint: 'SHA256:isolated-shell-fixture', publicKey: 'isolated-shell-fixture',
};

const error = (code, message) => Object.assign(new Error(message), { code });

/**
 * Exercises the production provisioning shell commands and binary daemon locally.
 * Only native SSH is substituted: each command runs a real non-PTY POSIX shell
 * under a private HOME, and all bytes cross real child-process stdin/stdout.
 * This fixture does not establish native transport, authentication, or VPN proof.
 */
export async function remoteShellConnector(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-provisioning-'));
  const home = join(directory, "owner's home");
  await mkdir(home);
  const children = new Set();
  const metrics = { connections: 0, disconnects: 0, commands: [], writes: [], exits: [] };
  const exits = new Map();

  const connector = async (settings) => {
    metrics.connections += 1;
    if (settings.signal?.aborted) throw error('CANCELLED', 'Cancelled before SSH trust.');
    const accepted = await settings.verifyHostKey(shellHostKey);
    if (!accepted) throw error('HOST_KEY_REJECTED', 'Untrusted fixture key.');
    if (settings.signal?.aborted) throw error('CANCELLED', 'Cancelled during SSH trust.');
    let closed = false;
    const owned = new Set();

    const connection = {
      async openShell(spec, events) {
        if (closed) throw error('CLOSED', 'Fixture connection closed.');
        if (spec.term !== '') throw new Error('Provisioning must not request a PTY.');
        await options.beforeOpen?.(spec.command, { home, metrics });
        if (closed) throw error('CLOSED', 'Fixture connection closed during channel admission.');
        metrics.commands.push(spec.command);
        const child = spawn('/bin/sh', ['-c', spec.command], {
          cwd: home,
          env: { ...process.env, ...options.environment, HOME: home },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.add(child);
        owned.add(child);
        let done = false;
        let resolveExit;
        const exited = new Promise((resolve) => { resolveExit = resolve; });
        exits.set(child, exited);
        child.stdout.on('data', (bytes) => events.onData(Uint8Array.from(bytes).buffer));
        child.stderr.on('data', (bytes) => events.onStderr?.(Uint8Array.from(bytes).buffer));
        child.stdin.on('error', () => {});
        child.on('close', (exitCode) => {
          done = true;
          children.delete(child);
          owned.delete(child);
          metrics.exits.push({ command: spec.command, exitCode });
          events.onClosed?.(exitCode ?? undefined);
          resolveExit();
        });
        return {
          write(bytes) {
            if (done) throw error('CLOSED', 'Fixture channel closed.');
            const data = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(new Uint8Array(bytes));
            if (data.length > 4 * 1024 * 1024) throw error('QUEUE_FULL', 'Native queue limit exceeded.');
            metrics.writes.push({ command: spec.command, bytes: data.length });
            child.stdin.write(data);
            options.onWrite?.(data, { child, home, metrics, command: spec.command });
          },
          sendEof() { child.stdin.end(); },
          async close() {
            if (!done) { child.stdin.end(); child.kill(); }
            await exited;
          },
        };
      },
      async exec(command) {
        const stdout = [];
        const stderr = [];
        let resolveExit;
        const exited = new Promise((resolve) => { resolveExit = resolve; });
        const shell = await connection.openShell({ term: '', command }, {
          onData: (bytes) => stdout.push(Buffer.from(bytes)),
          onStderr: (bytes) => stderr.push(Buffer.from(bytes)),
          onClosed: (exitCode) => resolveExit(exitCode ?? -1),
        });
        shell.sendEof();
        const exitCode = await exited;
        return { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(), exitCode };
      },
      async disconnect() {
        if (closed) return;
        closed = true;
        metrics.disconnects += 1;
        const pending = [...owned];
        for (const child of pending) { child.stdin.end(); child.kill(); }
        await Promise.all(pending.map((child) => exits.get(child)));
      },
    };
    return connection;
  };

  t.after(async () => {
    const pending = [...children];
    for (const child of pending) { child.stdin.end(); child.kill(); }
    await Promise.all(pending.map((child) => exits.get(child)));
    await rm(directory, { recursive: true, force: true });
  });
  return { connector, directory, home, metrics, children };
}
