import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';

import { createSshChannelFactory, type DaemonChannelFactory } from './channel';
import { Connection } from './connection';
import { MobileRemoteExecutionEnv } from './environment';
import { matchesHostKey, type RemoteHostAdmission, type RemoteHostRepository } from './hosts';
import type { RemotePlatformState } from './provisioning';

function admittedSshChannel(admission: RemoteHostAdmission, platform: RemotePlatformState): DaemonChannelFactory {
  const { host, auth, trustedHostKey } = admission;
  if (!trustedHostKey) {
    throw new Error('Test this machine in Remote machines and verify its SSH host key before running tools.');
  }
  return createSshChannelFactory({ host: host.hostname, port: host.port, username: host.username,
    auth, platform, hostKeyAlgorithms: [trustedHostKey.algorithm],
    verifyHostKey: (observed) => matchesHostKey(trustedHostKey, observed) });
}

export type RemoteExecution = ReturnType<typeof createRemoteExecution>;

/** One folder on a machine, as its daemon lists it. */
export interface RemoteFolder {
  home: string;
  /** The listed folder's absolute path. */
  path: string;
  /** Names of the folders inside, in the daemon's order; hidden names are left out. */
  names: string[];
}

export interface RemoteFolderSearch {
  /** Absolute paths of the matching folders. */
  matches: string[];
  /** The search's time ran out before the whole tree was visited. */
  stoppedEarly: boolean;
}

/** Levels below the searched folder that `searchFolders` visits. */
const SEARCH_DEPTH = 4;
const SEARCH_TIMEOUT_SECONDS = 10;

/** `find`'s patterns are shell globs; a query is matched literally. */
const globLiteral = (text: string) => text.replace(/[\\*?[\]]/g, '\\$&');

/**
 * Holds one SSH connection per machine, shared by the environments built on it at each use, as in pi-env's README.
 * The provider that creates it closes it after both Harnesses; a resolve after that opens a new connection.
 */
export function createRemoteExecution(hosts: RemoteHostRepository) {
  const connections = new Map<string, Connection>();
  return {
    async environment(machineId: string, cwd: string | undefined): Promise<MobileRemoteExecutionEnv> {
      await hosts.restore();
      const host = hosts.get(machineId);
      if (!host) {
        throw new Error('This remote machine was removed. Choose another execution environment in chat settings.');
      }
      let connection = connections.get(machineId);
      if (!connection) {
        const platform: RemotePlatformState = {};
        // Like pi-env's `command`, each start reads the machine's current credentials and trusted key.
        connection = new Connection({
          openChannel: async (options) => admittedSshChannel(await hosts.admit(machineId), platform)(options),
        });
        connections.set(machineId, connection);
      }
      // A chat without a working directory uses the account's home, as pi-env's external SSH test does.
      return new MobileRemoteExecutionEnv({ connection, id: `ssh:${host.namespaceId}`,
        cwd: cwd ?? (await connection.info()).home });
    },
    /**
     * Lists one folder, the home directory for `null`, through the same shared connection the chat's tools use, as
     * the Files app lists one level at a time. `signal` cancels only this request.
     */
    async listFolder(machineId: string, path: string | null, signal: AbortSignal): Promise<RemoteFolder> {
      const environment = await this.environment(machineId, undefined);
      const home = environment.cwd;
      const target = path ?? home;
      const listed = await environment.listDir(target, withAbortSignal(signal, BACKGROUND_CONTEXT));
      if (!listed.ok) throw listed.error;
      const names = listed.value.flatMap((entry) =>
        entry.kind === 'directory' && !entry.name.startsWith('.') ? [entry.name] : []);
      return { home, path: target, names };
    },
    /**
     * Finds folders named like `query` a few levels below `root` with the machine's own `find`, run without a shell.
     * Hidden folders are pruned. When the time runs out, the matches found so far are returned as a partial answer.
     */
    async searchFolders(machineId: string, root: string, query: string, signal: AbortSignal,
    ): Promise<RemoteFolderSearch> {
      const environment = await this.environment(machineId, undefined);
      let output = '';
      const result = await environment.exec(
        ['find', root, '-mindepth', '1', '-maxdepth', String(SEARCH_DEPTH), '-name', '.*', '-prune', '-o',
          '-type', 'd', '-iname', `*${globLiteral(query)}*`, '-print'],
        { timeout: SEARCH_TIMEOUT_SECONDS, onOutput: (text, _context, info) => {
          if (info.stream === 'stdout') output += text;
        } },
        withAbortSignal(signal, BACKGROUND_CONTEXT));
      // Unreadable folders make `find` exit nonzero after printing what it could; those matches are still right.
      if (!result.ok && result.error.code !== 'timeout') throw result.error;
      const matches = output.split('\n').filter((line) => line.startsWith('/')).sort();
      return { matches, stoppedEarly: !result.ok };
    },
    async close(): Promise<void> {
      const open = [...connections.values()];
      connections.clear();
      await Promise.all(open.map((connection) => connection.close()));
    },
  };
}
