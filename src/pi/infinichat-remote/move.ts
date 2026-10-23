import type { SshConnection, SshShell } from '@osuki-dev/react-native-ssh';
import { deflateAsync, inflateAsync } from '@strawberrytech/react-native-nitro-zlib';
import { Buffer } from 'buffer';
import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import { File } from 'expo-file-system';
import { backupDatabaseAsync, defaultDatabaseDirectory, openDatabaseAsync } from 'expo-sqlite';

import { connectionFailure } from '../execution/remote/channel';
import type { RemoteHostRepository } from '../execution/remote/hosts';
import { HASH, quotePosix, script } from '../execution/remote/provisioning';
import type { RemoteInfiniChat } from './client';
import type { ConversationFiles, ConversationState } from './contract';
import { PHONE_HOME, type InfiniChatHomeStore } from './home';
import { connectAdmitted, NODE, PRINT_MARKER, runScript, SERVER_BUNDLE } from './install';
import { apply, diff, pages, type Bytes, type PagePlatform } from './pages';

/** The phone's InfiniChat database, which expo-sqlite opens by name. */
export const INFINICHAT_DATABASE = 'infinichat.db';
/** The phone's copy after a move there: never opened, kept fresh, and patched by the next move back. */
const MOVED = 'infinichat-moved.db';
/** Where a move back puts the machine's database before it is placed. */
const INCOMING = 'infinichat-incoming.db';
/** A backup of the phone's open conversation, which a refresh patches the machine's copy with. */
const BACKUP = 'infinichat-backup.db';
/** A page list or patch from the machine, until it is read. */
const TRANSFER = 'infinichat-transfer';
/** The machine's conversation folder, in its account's home. */
const DATA = '.infinichat/data';
/** The machine's copy while this phone holds the conversation, which `archive` leaves there. */
const COPY = '.infinichat/copy/infinichat.db';

type ConversationFile = ConversationFiles['db'];
type Copied = { bytes: number; total: number };

export type MoveStep = 'connecting' | 'closing' | 'copying' | 'opening';
/** A move between this iPhone and a machine, while it runs and after a failure stopped it. */
export interface MoveStatus {
  machineId: string;
  to: 'machine' | 'phone';
  step: MoveStep;
  copied?: Copied;
  running: boolean;
  /** Why it stopped; the home record keeps its phase until it is tried again or cancelled. */
  error?: string;
  /** Cancel can still put the conversation back where it was. */
  cancellable: boolean;
  /** A Cancel is putting it back, or a failure stopped one. */
  undoing?: boolean;
}

/** What a move does to the two sides through their owner, the provider. */
export interface MoveSides {
  /** Keeps the screens on what they show, and their operations waiting, until `show` or `openPhone`. */
  hold(): void;
  /** Closes InfiniChat on this phone: its Harness, then its storage. */
  closePhone(): Promise<void>;
  /** Opens InfiniChat on this phone and shows it; it reports its own failure. */
  openPhone(): Promise<void>;
  /** The provider's client for the machine's InfiniChat, made when there is none. */
  machine(machineId: string): RemoteInfiniChat;
  show(remote: RemoteInfiniChat): void;
  closeMachine(): Promise<void>;
}

/** A file of the phone's InfiniChat, in the folder expo-sqlite opens databases from by name (its `databasePath`). */
function phoneFile(name: string): File {
  const directory: unknown = defaultDatabaseDirectory;
  if (typeof directory !== 'string') throw new Error('The app’s database folder is unavailable.');
  return new File(`file://${directory}`, name);
}

async function describe(file: File): Promise<ConversationFile | undefined> {
  return file.exists ? { sha256: await file.digest('SHA-256'), size: file.size } : undefined;
}

const same = (left: ConversationFile | undefined, right: ConversationFile | undefined) =>
  left?.sha256 === right?.sha256 && left?.size === right?.size;
/** The machine holds these files open: it adopted them, and the move there happened. */
const adopted = (held: ConversationState | undefined, files: ConversationFiles) => held?.active === true
  && same(held.adopted?.db, files.db);

/**
 * Folds the WAL a close left beside the phone's closed database into it, so the database file alone is the
 * conversation. Opening and closing alone leave it: SQLite opens the WAL at the first read.
 */
async function fold(name: string) {
  const database = await openDatabaseAsync(name);
  try {
    const result = await database.getFirstAsync<{ busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)');
    if (result?.busy !== 0) throw new Error('InfiniChat’s database on this iPhone is still in use. Try again.');
  } finally {
    await database.closeAsync();
  }
}

/** The closed database, with its WAL folded in. The `-shm` index never moves: SQLite rebuilds it. */
async function phoneFiles(): Promise<ConversationFiles> {
  // Opening a database that isn't there would create it.
  if (phoneFile(INFINICHAT_DATABASE).exists) await fold(INFINICHAT_DATABASE);
  const db = await describe(phoneFile(INFINICHAT_DATABASE));
  if (!db) throw new Error('This iPhone has no InfiniChat conversation to move.');
  return { db };
}

function remove(name: string) {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = phoneFile(`${name}${suffix}`);
    if (file.exists) file.delete();
  }
}

/** Renames a closed database over `to`'s; nothing is left of `to` that SQLite could pair with it. */
function rename(from: string, to: string) {
  remove(to);
  phoneFile(from).moveSync(phoneFile(to));
  remove(from);
}

/** The page diffs on the phone: expo-crypto, nitro-zlib off the JS thread, and the database folder. */
const phone: PagePlatform = {
  sha256: async (bytes) => new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, bytes)),
  // nitro-zlib takes a whole ArrayBuffer, so a view is copied into one of its own.
  gzip: async (bytes) => new Uint8Array(await deflateAsync(bytes.slice().buffer, 'gzip')),
  gunzip: async (bytes) => new Uint8Array(await inflateAsync(bytes.slice().buffer, 'gzip')),
  read: (name) => phoneFile(name).bytes(),
  async write(name, bytes) {
    const aside = phoneFile(`${name}.partial`);
    await aside.write(bytes);
    aside.moveSync(phoneFile(name), { overwrite: true });
  },
};

/**
 * Finds this app's server bundle on the machine and the Node that `server.json` says runs it (listen.ts), for the
 * page commands, and fails the script when either is missing: nothing here installs one.
 */
const SERVER = [`js="$HOME/.infinichat/server/${SERVER_BUNDLE}/server.js"`, '[ -f "$js" ]',
  's="$HOME/.infinichat/server.json"', `node=$(${NODE})`, '[ -n "$node" ]'];
/**
 * sshd doesn't stop a script whose channel closed, and the script's next write ends it with SIGPIPE, which skips its
 * exit trap; trapping it too removes the page list or patch it made.
 */
const ON_SIGNAL = `trap 'exit 1' HUP INT PIPE TERM`;
/** Never shown: a move that can't patch copies the whole file, and a refresh changes nothing. */
const PATCH_FAILED = 'The patch failed.';

/** Printed on its own line before the file's bytes; whatever the account's shell startup files print comes first. */
const COPY_MARKER = 'INFINICHAT-COPY';
const COPY_LINE = Buffer.from(`${COPY_MARKER}\n`);
const PRINT_COPY = `printf '%s\\n' ${COPY_MARKER}`;

/**
 * Streams what a script on the machine prints after the copy marker into `file`, over `openShell`: `exec` caps its
 * output at 16 MiB (react-native-ssh `src/errors.ts:20`). The bytes start after a marker line, as install.ts's answers
 * do, since sshd runs the command through the account's shell, whose startup files may print (zsh's `~/.zshenv`, or
 * `~/.bashrc` where bash sources it for SSH). Like the upload, it has no timeout of its own.
 */
async function downloadFile(connection: SshConnection, signal: AbortSignal, lines: string[], file: File,
  onRead: (bytes: number) => void) {
  file.create({ overwrite: true });
  const writer = file.writableStream().getWriter();
  let writing = Promise.resolve();
  let read = 0;
  // What arrived before the marker, until it has.
  let before: Buffer | undefined = Buffer.alloc(0);
  let ended = false;
  let finish: (status: number | undefined) => void = () => {};
  const closed = new Promise<number | undefined>((resolve) => { finish = resolve; });
  const end = (status: number | undefined) => {
    ended = true;
    finish(status);
  };
  let shell: SshShell | undefined;
  // A channel close can wait behind a dead link until the keepalive gives up; disconnecting the move's own connection
  // ends it at once, as runSshCommand's `fail` does.
  const abort = () => {
    end(undefined);
    void connection.disconnect().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    shell = await connection.openShell({ term: '', command: script(['set -eu', ...lines].join('\n')) }, {
      onData: (bytes) => {
        // Data still on its way after an abort goes nowhere.
        if (ended) return;
        // Native owns the buffer; copy it before the callback returns.
        let chunk = new Uint8Array(bytes).slice();
        if (before !== undefined) {
          const seen = Buffer.concat([before, chunk]);
          const at = seen.indexOf(COPY_LINE);
          if (at < 0) {
            before = seen;
            return;
          }
          before = undefined;
          chunk = new Uint8Array(seen.subarray(at + COPY_LINE.length));
        }
        read += chunk.byteLength;
        onRead(read);
        writing = writing.then(() => writer.write(chunk));
      },
      onStderr: () => {},
      onClosed: end,
    }).catch((error: unknown) => {
      throw connectionFailure(error);
    });
    if (signal.aborted) abort();
    const status = await closed;
    signal.throwIfAborted();
    await writing;
    await writer.close();
    if (status !== 0 || before !== undefined) {
      throw new Error('The SSH connection closed before the copy was complete.');
    }
  } catch (error) {
    writing.catch(() => {});
    await writer.abort().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    await shell?.close().catch(() => {});
  }
}

/** What a script on the machine prints after the copy marker, through the transfer file, which it then removes. */
async function fetchBytes(connection: SshConnection, signal: AbortSignal, lines: string[],
  onRead: (bytes: number) => void): Promise<Bytes> {
  const file = phoneFile(TRANSFER);
  try {
    await downloadFile(connection, signal, lines, file, onRead);
    return await file.bytes();
  } finally {
    if (file.exists) file.delete();
  }
}

/**
 * Sends the phone's database `from` as a patch against the machine's copy at `base`, which the machine applies,
 * verifies and renames to `out`: the copy's page list comes down, and the patch goes up as the whole file would. It
 * fails when the machine has no copy or no server of this bundle.
 */
async function sendPatch(connection: SshConnection, signal: AbortSignal, name: string, from: string, base: string,
  out: string, onCopied: (copied: Copied) => void) {
  const list = await fetchBytes(connection, signal, [...SERVER, 'umask 077',
    't=$(mktemp "$HOME/.infinichat/.pages.XXXXXX")', `trap 'rm -f "$t"' 0`, ON_SIGNAL,
    `"$node" "$js" pages "$HOME/${base}" "$t"`, PRINT_COPY, 'cat "$t"'], () => {});
  const patch = await diff(phone, from, list);
  await runScript(connection, signal, name, [...SERVER, 'umask 077', `mkdir -p "$(dirname "$HOME/${out}")"`,
    't=$(mktemp "$HOME/.infinichat/.patch.XXXXXX")', `trap 'rm -f "$t"' 0`, ON_SIGNAL,
    'cat > "$t"', `"$node" "$js" patch "$HOME/${base}" "$t" "$HOME/${out}"`, PRINT_MARKER],
  { failure: PATCH_FAILED, input: patch, timeoutMs: null,
    onWritten: (bytes) => onCopied({ bytes, total: patch.byteLength }) });
}

/**
 * Brings the phone's copy `base` up to the machine's database with a patch, applied, verified and renamed to `out`:
 * the page list goes up, the machine diffs (with `live`, a backup of the database it holds open), and the patch comes
 * down. The patch waits on the machine for the download, which removes it. It fails when the machine has no server of
 * this bundle.
 */
async function receivePatch(connection: SshConnection, signal: AbortSignal, name: string, live: boolean, base: string,
  out: string, onCopied: (copied: Copied) => void) {
  const [path, size] = await runScript(connection, signal, name, [...SERVER, 'umask 077',
    'p=$(mktemp "$HOME/.infinichat/.pages.XXXXXX")', 'o=$(mktemp "$HOME/.infinichat/.patch.XXXXXX")',
    `trap 'rm -f "$p" "$o"' 0`, ON_SIGNAL, 'cat > "$p"',
    `"$node" "$js" diff "$HOME/${DATA}/${INFINICHAT_DATABASE}" "$p" "$o"${live ? ' --live' : ''}`,
    PRINT_MARKER, `printf '%s\\n' "$o"`, 'wc -c < "$o"', `trap 'rm -f "$p"' 0`],
  { failure: PATCH_FAILED, input: await pages(phone, base), timeoutMs: null });
  const total = Number(size);
  if (!path?.startsWith('/') || !Number.isSafeInteger(total)) throw new Error(PATCH_FAILED);
  const patch = await fetchBytes(connection, signal, [`o=${quotePosix(path)}`, `trap 'rm -f "$o"' 0`, ON_SIGNAL,
    PRINT_COPY, 'cat "$o"'], (bytes) => onCopied({ bytes, total }));
  await apply(phone, base, patch, out);
}

/** The connection while it is up; once dropped, it is let go and a new one is made. */
async function reconnected(connection: SshConnection, connect: () => Promise<SshConnection>) {
  if (connection.isConnected) return connection;
  await connection.disconnect().catch(() => {});
  return connect();
}

/**
 * Puts the phone's closed database into the machine's `data/incoming/`: as a patch against the machine's copy, or as
 * the whole file when there is no copy or the patch fails, uploaded aside, verified by SHA-256 and renamed into place
 * as provisioning.ts uploads the daemon. Uploads go through `openShell` with input, since react-native-ssh's `exec` has
 * no stdin, and have no timeout of their own: they end with the copy, the user's Cancel, or the SSH connection, whose
 * keepalive notices a dead machine. Moving it into `data/` is refused while the machine holds a conversation open; a
 * database an earlier one left there is kept in `released/`. The copy runs over an SSH connection of its own from
 * `connect`, and over a new one for the whole file when the patch's failure took the first with it: a dropped link
 * leaves it down, and runSshCommand's `fail` disconnects it.
 */
async function upload(connect: () => Promise<SshConnection>, signal: AbortSignal, name: string,
  files: ConversationFiles, onCopied: (copied: Copied) => void) {
  const failure = `Check the account’s home folder permissions and disk space on ${name}.`;
  let connection = await connect();
  try {
    try {
      await sendPatch(connection, signal, name, INFINICHAT_DATABASE, COPY, `${DATA}/incoming/${INFINICHAT_DATABASE}`,
        onCopied);
    } catch {
      signal.throwIfAborted();
      connection = await reconnected(connection, connect);
      await runScript(connection, signal, name, [HASH, `d="$HOME/${DATA}/incoming"`, 'umask 077', 'mkdir -p "$d"',
        't=$(mktemp "$d/.upload.XXXXXX")', `trap 'rm -f "$t"' 0`, ON_SIGNAL, 'cat > "$t"',
        `[ "$(hash "$t")" = ${files.db.sha256} ]`, `mv -f "$t" "$d/${INFINICHAT_DATABASE}"`, PRINT_MARKER],
      { failure, input: await phoneFile(INFINICHAT_DATABASE).bytes(), timeoutMs: null,
        onWritten: (bytes) => onCopied({ bytes, total: files.db.size }) });
    }
    const db = `"$d/${INFINICHAT_DATABASE}"`;
    const [placed] = await runScript(connection, signal, name, ['umask 077', `d="$HOME/${DATA}"`,
      's="$HOME/.infinichat/state.json"', PRINT_MARKER,
      `if [ -f "$s" ] && grep -q '"active":true' "$s"; then echo active; exit 0; fi`,
      `if [ -e ${db} ]; then r="$HOME/.infinichat/released/$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$"`,
      `  mkdir -p "$r"; mv ${db}* "$r/"; fi`,
      `rm -f ${db}-wal ${db}-shm`,
      `mv -f "$d/incoming/${INFINICHAT_DATABASE}" ${db}`, 'echo placed'], { failure });
    if (placed === 'active') throw new Error(`InfiniChat is already open on ${name}.`);
    if (placed !== 'placed') throw new Error(failure);
  } finally {
    await connection.disconnect().catch(() => {});
  }
}

/**
 * Brings the database the machine named to the phone's incoming copy: as a patch against the phone's moved copy, or
 * as the whole file when there is no copy or the patch fails. Either is checked against what the machine named. Its
 * connections are the upload's: its own, and a new one when the patch took the first with it.
 */
async function download(connect: () => Promise<SshConnection>, signal: AbortSignal, name: string,
  files: ConversationFiles, onCopied: (copied: Copied) => void) {
  remove(INCOMING);
  const incoming = phoneFile(INCOMING);
  let connection = await connect();
  try {
    try {
      await receivePatch(connection, signal, name, false, MOVED, INCOMING, onCopied);
      if (same(await describe(incoming), files.db)) return;
    } catch {
      signal.throwIfAborted();
    }
    connection = await reconnected(connection, connect);
    await downloadFile(connection, signal, [PRINT_COPY, `exec cat "$HOME/${DATA}/${INFINICHAT_DATABASE}"`],
      incoming, (bytes) => onCopied({ bytes, total: files.db.size }));
    if (!same(await describe(incoming), files.db)) {
      throw new Error(`The copy from ${name} doesn’t match what InfiniChat left there. Try again.`);
    }
  } finally {
    await connection.disconnect().catch(() => {});
  }
}

/**
 * Patches the machine's copy with a backup of the phone's open conversation, taken over a second connection with
 * SQLite's backup API, which copies a consistent state at the same page numbers while the Harness goes on writing.
 */
async function refreshCopy(connection: SshConnection, signal: AbortSignal, name: string) {
  remove(BACKUP);
  try {
    const source = await openDatabaseAsync(INFINICHAT_DATABASE, { useNewConnection: true });
    try {
      const backup = await openDatabaseAsync(BACKUP, { useNewConnection: true });
      try {
        await backupDatabaseAsync({ sourceDatabase: source, destDatabase: backup });
      } finally {
        await backup.closeAsync();
      }
    } finally {
      await source.closeAsync();
    }
    await sendPatch(connection, signal, name, BACKUP, COPY, COPY, () => {});
  } finally {
    remove(BACKUP);
  }
}

/**
 * Moves InfiniChat's conversation between this iPhone and a machine, one move at a time, as upstream's session sync
 * hands a session over (pi `replication` branch, `packages/durable/test/sync-e2e.test.ts:143-171`): the giving side
 * closes its Harness, the files are copied, and the other side opens them, where pi-durable's recovery resumes the work
 * the close interrupted. Nothing drains or waits. The home record names each phase before the step that needs it, so
 * `resume` carries a move on after a relaunch or a failure. The copy is the one seam upstream's replication could
 * replace: `upload` and `download`, which send the pages that changed since the other side's copy, and `refresh`,
 * which keeps that copy fresh.
 */
export class InfiniChatMoves {
  private readonly listeners = new Set<() => void>();
  private status?: MoveStatus;
  /** What the last move wants the user to know once it is done, until dismissed. */
  private notice?: string;
  private attempt?: { controller: AbortController; cancelled: boolean };
  private running: Promise<void> = Promise.resolve();
  /** The refresh under way, which a move, the background and `close` stop. */
  private refreshing?: AbortController;
  private refreshed: Promise<void> = Promise.resolve();
  /** This attempt saw the machine without the conversation open, and has not asked it to adopt since. */
  private machineClosed = false;
  private closed = false;

  constructor(private readonly home: InfiniChatHomeStore, private readonly hosts: RemoteHostRepository,
    private readonly sides: MoveSides) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  readonly getSnapshot = () => this.status;
  readonly getNotice = () => this.notice;

  dismissNotice() {
    this.notice = undefined;
    this.notify();
  }

  /** Moves the conversation to the machine, or to this phone for `null`, from where it lives. */
  choose(machineId: string | null) {
    const home = this.home.getSnapshot();
    if (this.attempt || this.status) return;
    if (machineId !== null && home.home === 'phone') this.run(machineId, 'machine');
    else if (machineId === null && home.home === 'machine' && home.phase === 'there') this.run(home.machineId, 'phone');
  }

  /** Carries a move on from the phase the home record keeps, at launch and when the app becomes active. */
  resume() {
    const home = this.home.getSnapshot();
    if (this.attempt || home.home !== 'machine' || home.phase === 'there') return;
    this.run(home.machineId, home.phase === 'moving-there' ? 'machine' : 'phone');
  }

  /**
   * Brings the copy the other side keeps up to date, at launch and when the app returns from the background, so the
   * next move has little to send: the phone's moved copy while the machine holds the conversation, the copy on
   * `copyOn` while the phone does, each from a backup of the open database. It writes only that copy, aside and
   * renamed into place, so stopping it anywhere leaves the old one, and one that fails changes nothing and runs again
   * next time.
   */
  refresh() {
    const home = this.home.getSnapshot();
    const machineId = home.home === 'phone' ? home.copyOn : home.phase === 'there' ? home.machineId : undefined;
    if (this.closed || this.attempt || this.refreshing || machineId === undefined) return;
    const controller = new AbortController();
    this.refreshing = controller;
    this.refreshed = (async () => {
      let connection: SshConnection | undefined;
      try {
        connection = await this.connect(machineId, controller.signal);
        const name = this.name(machineId);
        if (home.home === 'phone') await refreshCopy(connection, controller.signal, name);
        else await receivePatch(connection, controller.signal, name, true, MOVED, MOVED, () => {});
      } catch {
        // The next move works without it.
      } finally {
        await connection?.disconnect().catch(() => {});
        this.refreshing = undefined;
      }
    })();
  }

  /** Stops a refresh where it is, as the app going to the background does. */
  stopRefresh() {
    this.refreshing?.abort();
  }

  /** A machine removed from Remote machines keeps no copy for this phone to refresh. */
  forget(machineId: string) {
    const home = this.home.getSnapshot();
    if (home.home === 'phone' && home.copyOn === machineId) this.home.set(PHONE_HOME);
  }

  /** Runs a move a failure stopped again, forward, also when the failure was a Cancel's. */
  retry() {
    const status = this.status;
    if (this.attempt || status?.error === undefined) return;
    this.run(status.machineId, status.to);
  }

  /** Puts the conversation back where it was, before the opening step only; the only way into the undo. */
  cancel() {
    const status = this.status;
    if (!status?.cancellable) return;
    if (!this.attempt) {
      // Nothing moved yet: the failure only goes away.
      const home = this.home.getSnapshot();
      if (home.home === 'phone' || home.phase === 'there') {
        this.status = undefined;
        this.notify();
        if (home.home === 'phone') void this.sides.closeMachine();
        return;
      }
      this.run(status.machineId, status.to, true);
      return;
    }
    this.attempt.cancelled = true;
    this.attempt.controller.abort();
  }

  /** Stops a move where it is, as the app stopping would; the home record carries it on at the next launch. */
  close(): Promise<void> {
    this.closed = true;
    this.attempt?.controller.abort();
    this.stopRefresh();
    return Promise.all([this.running, this.refreshed]).then(() => {});
  }

  private run(machineId: string, to: MoveStatus['to'], cancelling = false) {
    // A move replaces the copies a refresh writes, so it waits until a refresh it stops has let go of them.
    this.stopRefresh();
    const refreshed = this.refreshed;
    const attempt = { controller: new AbortController(), cancelled: cancelling };
    this.attempt = attempt;
    this.machineClosed = false;
    this.notice = undefined;
    this.status = { machineId, to, step: to === 'machine' ? 'connecting' : 'closing', running: true,
      cancellable: !cancelling };
    this.notify();
    this.running = (async () => {
      await refreshed;
      if (!cancelling) {
        try {
          // A move that got this far finished: a Cancel too late to stop it changes nothing.
          await (to === 'machine' ? this.there(machineId, attempt.controller.signal)
            : this.back(machineId, attempt.controller.signal));
          this.status = undefined;
          return;
        } catch (error) {
          if (this.closed) return;
          if (!attempt.cancelled) {
            const status = this.status ?? { machineId, to, step: 'connecting', cancellable: true };
            this.status = { ...status, running: false, cancellable: true, error: this.failure(status, error) };
            return;
          }
        }
      }
      // Cancelled, with a new signal, which only closing aborts.
      attempt.controller = new AbortController();
      const step = this.status?.step ?? 'closing';
      this.status = { machineId, to, step, running: true, cancellable: false, undoing: true };
      this.notify();
      try {
        await this.undo(machineId, to, attempt.controller.signal);
        this.status = undefined;
      } catch (error) {
        if (this.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        this.status = { machineId, to, step, running: false, cancellable: true, undoing: true,
          error: `The move could not be cancelled. ${message}` };
      }
    })().finally(() => {
      this.attempt = undefined;
      this.notify();
    });
  }

  /**
   * Phone → machine. The machine runs this app's bundle before the phone closes anything, so both sides run the same
   * pi-durable and no one-way migration runs on a copy the other side can't read. Until the machine has adopted them,
   * the phone's files are the conversation; a machine that already holds them open finished the move.
   */
  private async there(machineId: string, signal: AbortSignal) {
    const remote = this.sides.machine(machineId);
    const name = this.name(machineId);
    await remote.connected(signal);
    if (this.home.getSnapshot().home === 'phone') {
      this.step({ step: 'closing' });
      this.home.set({ version: 1, home: 'machine', machineId, phase: 'moving-there' });
      this.sides.hold();
      await this.sides.closePhone();
    }
    signal.throwIfAborted();
    const files = await phoneFiles();
    const held = remote.getConversation();
    if (!adopted(held, files)) {
      if (held?.active) throw new Error(`InfiniChat on ${name} already has another conversation open.`);
      this.machineClosed = true;
      this.step({ step: 'copying' });
      await upload(() => this.connect(machineId, signal), signal, name, files,
        (copied) => this.step({ step: 'copying', copied }));
      signal.throwIfAborted();
      this.machineClosed = false;
      this.step({ step: 'opening' }, false);
      await remote.adopt(files);
    }
    this.arrived(machineId, remote);
  }

  /** The machine holds the conversation: the record says so, and the screens show it there. */
  private arrived(machineId: string, remote: RemoteInfiniChat) {
    this.home.set({ version: 1, home: 'machine', machineId, phase: 'there' });
    try {
      rename(INFINICHAT_DATABASE, MOVED);
    } catch {
      // Under either name the phone's copy is never opened while the machine holds the conversation, and the next
      // move back replaces it.
    }
    this.sides.show(remote);
  }

  /**
   * Machine → phone. The machine closes the conversation and names its files, which stay unchanged there until
   * `archive`, so a relaunch downloads them again and Cancel has the machine open them again.
   */
  private async back(machineId: string, signal: AbortSignal) {
    const remote = this.sides.machine(machineId);
    const name = this.name(machineId);
    this.step({ step: 'closing' });
    // A machine that can't be reached can't hand the conversation back; it stays there, shown as it was.
    await remote.connected(signal);
    const home = this.home.getSnapshot();
    if (home.home === 'machine' && home.phase === 'there') {
      this.home.set({ version: 1, home: 'machine', machineId, phase: 'moving-back' });
    }
    this.sides.hold();
    const files = await remote.relinquish();
    signal.throwIfAborted();
    this.step({ step: 'copying' });
    await download(() => this.connect(machineId, signal), signal, name, files,
      (copied) => this.step({ step: 'copying', copied }));
    signal.throwIfAborted();
    this.step({ step: 'opening' }, false);
    rename(INCOMING, INFINICHAT_DATABASE);
    remove(MOVED);
    // The placed files are the conversation now, and nothing has opened them, so the record names the phone before it
    // opens them: a relaunch never downloads over work the phone has done. The machine's copy is kept fresh from now.
    this.home.set({ version: 1, home: 'phone', copyOn: machineId });
    await this.sides.openPhone();
    // A machine never opens released files, and the next move there sets them aside, so this may fail; the machine
    // then has no copy to refresh, and the next move there sends the whole file.
    await remote.archive().catch(() => {});
    await this.sides.closeMachine();
  }

  private async undo(machineId: string, to: MoveStatus['to'], signal: AbortSignal) {
    const remote = this.sides.machine(machineId);
    const home = this.home.getSnapshot();
    if (to === 'machine') {
      if (home.home === 'machine' && home.phase === 'moving-there') {
        // The phone's files are the conversation only while the machine never opened them. A machine that did (its
        // answer to `adopt` lost with the link) holds them now and may already be working, so finishing the move is
        // the only outcome that never opens the conversation twice.
        if (!this.machineClosed) {
          await remote.connected(signal);
          if (adopted(remote.getConversation(), await phoneFiles())) {
            this.arrived(machineId, remote);
            this.notice = `InfiniChat had already opened on ${this.name(machineId)}, so the move finished and it `
              + 'runs there now. Choose This iPhone to move it back.';
            return;
          }
        }
        this.home.set(PHONE_HOME);
        await this.sides.openPhone();
      }
      await this.sides.closeMachine();
    } else if (home.home === 'machine' && home.phase === 'moving-back') {
      // The machine's files are unchanged since it relinquished them, so it opens them again.
      await remote.connected(signal);
      if (!remote.getConversation()?.active) await remote.adopt(await remote.relinquish());
      this.home.set({ version: 1, home: 'machine', machineId, phase: 'there' });
      remove(INCOMING);
      this.sides.show(remote);
    }
  }

  private async connect(machineId: string, signal: AbortSignal): Promise<SshConnection> {
    return connectAdmitted(await this.hosts.admit(machineId), { signal });
  }

  private name(machineId: string): string {
    return this.hosts.get(machineId)?.name ?? 'the machine';
  }

  /** Names the step that failed, then why. */
  private failure(status: Pick<MoveStatus, 'machineId' | 'to' | 'step'>, error: unknown): string {
    const name = this.name(status.machineId);
    const there = status.to === 'machine';
    const step = status.step === 'connecting' ? `Connecting to ${name} failed.`
      : status.step === 'closing' ? `Closing InfiniChat on ${there ? 'this iPhone' : name} failed.`
        : status.step === 'copying' ? `Copying InfiniChat ${there ? 'to' : 'from'} ${name} failed.`
          : `Opening InfiniChat on ${there ? name : 'this iPhone'} failed.`;
    return `${step} ${error instanceof Error ? error.message : String(error)}`;
  }

  private step(update: Pick<MoveStatus, 'step' | 'copied'>, cancellable = true) {
    const status = this.status;
    if (!status || this.closed) return;
    this.status = { machineId: status.machineId, to: status.to, running: true, cancellable, ...update };
    this.notify();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
}
