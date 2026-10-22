import type { SshConnection, SshShell } from '@osuki-dev/react-native-ssh';
import { File } from 'expo-file-system';
import { defaultDatabaseDirectory } from 'expo-sqlite';

import { connectionFailure } from '../execution/remote/channel';
import type { RemoteHostRepository } from '../execution/remote/hosts';
import { HASH, script } from '../execution/remote/provisioning';
import type { RemoteInfiniChat } from './client';
import type { ConversationFiles } from './contract';
import { PHONE_HOME, type InfiniChatHomeStore } from './home';
import { connectAdmitted, PRINT_MARKER, runScript, type InstallStage } from './install';

/** The phone's InfiniChat database, which expo-sqlite opens by name. */
export const INFINICHAT_DATABASE = 'infinichat.db';
/** The phone's files after a move there: never opened, kept until the next move back has placed its own. */
const MOVED = 'infinichat-moved.db';
/** Where a move back downloads the machine's files before they are placed. */
const INCOMING = 'infinichat-incoming.db';
/** The machine's conversation folder, in its account's home. */
const DATA = '.infinichat/data';
const WAL = '-wal';

type ConversationFile = ConversationFiles['db'];

export type MoveStep = 'connecting' | 'closing' | 'copying' | 'opening';
/** A move between this iPhone and a machine, while it runs and after a failure stopped it. */
export interface MoveStatus {
  machineId: string;
  to: 'machine' | 'phone';
  step: MoveStep;
  /** While connecting: what the install is doing. */
  stage?: InstallStage;
  copied?: { bytes: number; total: number };
  running: boolean;
  /** Why it stopped; the home record keeps its phase until it is tried again or cancelled. */
  error?: string;
  /** Cancel can still put the conversation back where it was. */
  cancellable: boolean;
  /** Cancel is putting it back. */
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
const parts = (files: ConversationFiles): [string, ConversationFile][] =>
  files.wal === undefined ? [['', files.db]] : [['', files.db], [WAL, files.wal]];
const total = (files: ConversationFiles) => files.db.size + (files.wal?.size ?? 0);

/**
 * The closed database and the WAL its close left, if any. The `-shm` index never moves: SQLite rebuilds it, and a
 * copy of one can disagree with the WAL beside it.
 */
async function phoneFiles(): Promise<ConversationFiles> {
  const db = await describe(phoneFile(INFINICHAT_DATABASE));
  if (!db) throw new Error('This iPhone has no InfiniChat conversation to move.');
  const wal = await describe(phoneFile(`${INFINICHAT_DATABASE}${WAL}`));
  return { db, ...(wal === undefined ? {} : { wal }) };
}

function remove(name: string) {
  for (const suffix of ['', WAL, '-shm']) {
    const file = phoneFile(`${name}${suffix}`);
    if (file.exists) file.delete();
  }
}

/** Renames a closed database and its WAL over `to`'s; nothing is left of `to` that SQLite could pair with them. */
function rename(from: string, to: string) {
  remove(to);
  // The WAL first: a database placed without its WAL would lose the commits in it.
  for (const suffix of [WAL, '']) {
    const file = phoneFile(`${from}${suffix}`);
    if (file.exists) file.moveSync(phoneFile(`${to}${suffix}`));
  }
  remove(from);
}

/**
 * Uploads the phone's files to the machine's `data/incoming/`, each verified by SHA-256 and renamed into place there,
 * as provisioning.ts uploads the daemon, then moves them into `data/`. The upload goes through `openShell` with input,
 * since react-native-ssh's `exec` has no stdin. It has no timeout of its own: it ends with the copy, the user's Cancel,
 * or the SSH connection, whose keepalive notices a dead machine. Placing is refused while the machine holds a
 * conversation open; a database an earlier one left there is kept in `released/`, as `archive` keeps one.
 */
async function upload(connection: SshConnection, signal: AbortSignal, name: string, files: ConversationFiles,
  onCopied: (bytes: number) => void) {
  const failure = `Check the account’s home folder permissions and disk space on ${name}.`;
  let copied = 0;
  for (const [suffix, file] of parts(files)) {
    const bytes = await phoneFile(`${INFINICHAT_DATABASE}${suffix}`).bytes();
    const before = copied;
    await runScript(connection, signal, name, [HASH, `d="$HOME/${DATA}/incoming"`, 'umask 077', 'mkdir -p "$d"',
      't=$(mktemp "$d/.upload.XXXXXX")', `trap 'rm -f "$t"' 0`, `trap 'exit 1' HUP INT TERM`, 'cat > "$t"',
      `[ "$(hash "$t")" = ${file.sha256} ]`, `mv -f "$t" "$d/${INFINICHAT_DATABASE}${suffix}"`, PRINT_MARKER],
    { failure, input: bytes, timeoutMs: null, onWritten: (written) => onCopied(before + written) });
    copied += bytes.byteLength;
  }
  const db = `"$d/${INFINICHAT_DATABASE}"`;
  const [placed] = await runScript(connection, signal, name, ['umask 077', `d="$HOME/${DATA}"`,
    's="$HOME/.infinichat/state.json"', PRINT_MARKER,
    `if [ -f "$s" ] && grep -q '"active":true' "$s"; then echo active; exit 0; fi`,
    `if [ -e ${db} ]; then r="$HOME/.infinichat/released/$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$"`,
    `  mkdir -p "$r"; mv ${db}* "$r/"; fi`,
    `rm -f ${db}-wal ${db}-shm`,
    files.wal === undefined ? `rm -f "$d/incoming/${INFINICHAT_DATABASE}-wal"`
      : `mv -f "$d/incoming/${INFINICHAT_DATABASE}-wal" ${db}-wal`,
    `mv -f "$d/incoming/${INFINICHAT_DATABASE}" ${db}`, 'echo placed'], { failure });
  if (placed === 'active') throw new Error(`InfiniChat is already open on ${name}.`);
  if (placed !== 'placed') throw new Error(failure);
}

/**
 * Streams one of the machine's files into `file` with `cat` over `openShell`: `exec` caps its output at 16 MiB
 * (react-native-ssh `src/errors.ts:20`). Like the upload, it has no timeout of its own.
 */
async function downloadFile(connection: SshConnection, signal: AbortSignal, path: string, file: File,
  onRead: (bytes: number) => void) {
  file.create({ overwrite: true });
  const writer = file.writableStream().getWriter();
  let writing = Promise.resolve();
  let read = 0;
  let ended = false;
  let finish: (status: number | undefined) => void = () => {};
  const closed = new Promise<number | undefined>((resolve) => { finish = resolve; });
  const end = (status: number | undefined) => {
    ended = true;
    finish(status);
  };
  let shell: SshShell | undefined;
  const abort = () => end(undefined);
  signal.addEventListener('abort', abort, { once: true });
  try {
    shell = await connection.openShell({ term: '', command: script(`exec cat "$HOME/${path}"`) }, {
      onData: (bytes) => {
        // Data still on its way after an abort goes nowhere.
        if (ended) return;
        // Native owns the buffer; copy it before the callback returns.
        const chunk = new Uint8Array(bytes).slice();
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
    if (status !== 0) throw new Error('The SSH connection closed before the copy was complete.');
  } catch (error) {
    writing.catch(() => {});
    await writer.abort().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    await shell?.close().catch(() => {});
  }
}

/** Downloads the files the machine named to the phone's incoming copy and verifies each. */
async function download(connection: SshConnection, signal: AbortSignal, name: string, files: ConversationFiles,
  onCopied: (bytes: number) => void) {
  remove(INCOMING);
  let copied = 0;
  for (const [suffix, expected] of parts(files)) {
    const file = phoneFile(`${INCOMING}${suffix}`);
    const before = copied;
    await downloadFile(connection, signal, `${DATA}/${INFINICHAT_DATABASE}${suffix}`, file,
      (bytes) => onCopied(before + bytes));
    if (!same(await describe(file), expected)) {
      throw new Error(`The copy from ${name} doesn’t match what InfiniChat left there. Try again.`);
    }
    copied += expected.size;
  }
}

/**
 * Moves InfiniChat's conversation between this iPhone and a machine, one move at a time, as upstream's session sync
 * hands a session over (pi `replication` branch, `packages/durable/test/sync-e2e.test.ts:143-171`): the giving side
 * closes its Harness, the files are copied, and the other side opens them, where pi-durable's recovery resumes the work
 * the close interrupted. Nothing drains or waits. The home record names each phase before the step that needs it, so
 * `resume` carries a move on after a relaunch or a failure. The copy is the one seam upstream's replication could
 * replace: `upload` and `download`.
 */
export class InfiniChatMoves {
  private readonly listeners = new Set<() => void>();
  private status?: MoveStatus;
  private attempt?: { controller: AbortController; cancelled: boolean };
  private running: Promise<void> = Promise.resolve();
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

  /** Moves the conversation to the machine, or to this phone for `null`, from where it lives. */
  choose(machineId: string | null) {
    const home = this.home.getSnapshot();
    if (this.attempt || this.status) return;
    if (machineId !== null && home.home === 'phone') this.run(machineId, 'machine');
    else if (machineId === null && home.home === 'machine' && home.phase === 'there') this.run(home.machineId, 'phone');
  }

  /**
   * Carries a move on from the phase the home record keeps, at launch and when the app becomes active; a Cancel a
   * failure stopped goes on as a Cancel.
   */
  resume() {
    const home = this.home.getSnapshot();
    if (this.attempt || home.home !== 'machine' || home.phase === 'there') return;
    if (this.status?.undoing) this.run(this.status.machineId, this.status.to, true);
    else this.run(home.machineId, home.phase === 'moving-there' ? 'machine' : 'phone');
  }

  /** Runs a move a failure stopped again. */
  retry() {
    const status = this.status;
    if (this.attempt || status?.error === undefined) return;
    if (status.undoing) this.run(status.machineId, status.to, true);
    else this.run(status.machineId, status.to);
  }

  /** Puts the conversation back where it was, before the opening step only. */
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
    return this.running;
  }

  private run(machineId: string, to: MoveStatus['to'], cancelling = false) {
    const attempt = { controller: new AbortController(), cancelled: cancelling };
    this.attempt = attempt;
    this.machineClosed = false;
    this.status = { machineId, to, step: to === 'machine' ? 'connecting' : 'closing', running: true,
      cancellable: !cancelling };
    this.notify();
    this.running = (async () => {
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
    const stop = remote.subscribe(() => {
      const connection = remote.getConnection();
      if (this.status?.step === 'connecting' && connection.status === 'connecting') {
        this.step({ step: 'connecting', stage: connection.stage });
      }
    });
    try {
      await remote.connected(signal);
    } finally {
      stop();
    }
    if (this.home.getSnapshot().home === 'phone') {
      this.step({ step: 'closing' });
      this.home.set({ version: 1, home: 'machine', machineId, phase: 'moving-there' });
      this.sides.hold();
      await this.sides.closePhone();
    }
    signal.throwIfAborted();
    const files = await phoneFiles();
    const held = remote.getConversation();
    if (!held?.active || !same(held.adopted?.db, files.db) || !same(held.adopted?.wal, files.wal)) {
      if (held?.active) throw new Error(`InfiniChat on ${name} already has another conversation open.`);
      this.machineClosed = true;
      this.step({ step: 'copying', copied: { bytes: 0, total: total(files) } });
      const connection = await this.connect(machineId, signal);
      try {
        await upload(connection, signal, name, files,
          (bytes) => this.step({ step: 'copying', copied: { bytes, total: total(files) } }));
      } finally {
        await connection.disconnect().catch(() => {});
      }
      signal.throwIfAborted();
      this.machineClosed = false;
      this.step({ step: 'opening' }, false);
      await remote.adopt(files);
    }
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
    this.step({ step: 'copying', copied: { bytes: 0, total: total(files) } });
    const connection = await this.connect(machineId, signal);
    try {
      await download(connection, signal, name, files,
        (bytes) => this.step({ step: 'copying', copied: { bytes, total: total(files) } }));
    } finally {
      await connection.disconnect().catch(() => {});
    }
    signal.throwIfAborted();
    this.step({ step: 'opening' }, false);
    rename(INCOMING, INFINICHAT_DATABASE);
    remove(MOVED);
    // The placed files are the conversation now, and nothing has opened them, so the record names the phone before it
    // opens them: a relaunch never downloads over work the phone has done.
    this.home.set(PHONE_HOME);
    await this.sides.openPhone();
    // A machine never opens released files, and the next move there sets them aside, so this may fail.
    await remote.archive().catch(() => {});
    await this.sides.closeMachine();
  }

  private async undo(machineId: string, to: MoveStatus['to'], signal: AbortSignal) {
    const remote = this.sides.machine(machineId);
    const home = this.home.getSnapshot();
    if (to === 'machine') {
      if (home.home === 'machine' && home.phase === 'moving-there') {
        // The phone's files are the conversation only while the machine never opened them.
        if (!this.machineClosed) {
          await remote.connected(signal);
          if (remote.getConversation()?.active) {
            throw new Error(`InfiniChat is already open on ${this.name(machineId)}. Try again to finish the move.`);
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

  private step(update: Pick<MoveStatus, 'step' | 'stage' | 'copied'>, cancellable = true) {
    const status = this.status;
    if (!status || this.closed) return;
    this.status = { machineId: status.machineId, to: status.to, running: true, cancellable, ...update };
    this.notify();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
}
