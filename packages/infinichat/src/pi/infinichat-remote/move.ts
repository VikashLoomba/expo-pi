import { awaitWithContext, BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { BinaryReader, ExecutionEnv } from '@earendil-works/pi-durable/env';

import type { RemoteInfiniChat } from './client';
import type { ConversationFiles, ConversationState, InfiniChatClient } from './contract';
import type { MachineDirectory } from './dialer';
import { PHONE_HOME, type InfiniChatHomeStore } from './home';
import { NODE } from './install';
import { keyExchangeLines } from './keys';
import { fileFailure, HASH, PRINT_MARKER, runScript, temporary } from './machine';
import { apply, diff, pages, type PagePlatform } from './pages';

/** This device's InfiniChat database, which its storage opens by name. */
export const INFINICHAT_DATABASE = 'infinichat.db';
/** This device's copy after a move there: never opened, kept fresh, and patched by the next move back. */
const MOVED = 'infinichat-moved.db';
/** Where a move back puts the machine's database before it is placed. */
const INCOMING = 'infinichat-incoming.db';
/** A backup of this device's open conversation, which a refresh patches the machine's copy with. */
const BACKUP = 'infinichat-backup.db';
/** A patch from the machine, until it is applied. */
const TRANSFER = 'infinichat-transfer';
/** The machine's InfiniChat folder, in its account's home, which only that account enters. */
const FOLDER = '.infinichat';
/** The machine's conversation folder. */
const DATA = `${FOLDER}/data`;
/** The machine's copy while this device holds the conversation, which `archive` leaves there. */
const COPY = `${FOLDER}/copy/infinichat.db`;
/**
 * The bytes of one call of a copy, between progress reports. Each call keeps upstream's pipeline busy: writes of
 * 512 KiB and reads of 256 KiB, eight in flight (pi-env `remote-env.js`, which the phone's port matches).
 */
const CHUNK = 4 * 1024 * 1024;

type ConversationFile = ConversationFiles['db'];
type Copied = { bytes: number; total: number };

export type MoveStep = 'connecting' | 'closing' | 'copying' | 'opening';
/** A move between this device and a machine, while it runs and after a failure stopped it. */
export interface MoveStatus {
  machineId: string;
  /** `phone` is this device, as in the home record. */
  to: 'machine' | 'phone';
  /** The machine a move straight to `machineId` comes from; this device otherwise. */
  from?: string;
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

/** What a move does to the two sides through their owner, the app's provider. */
export interface MoveSides {
  /** Keeps the screens on what they show, and their operations waiting, until `show` or `openLocal`. */
  hold(): void;
  /** Closes InfiniChat on this device: its Harness, then its storage. */
  closeLocal(): Promise<void>;
  /** Opens InfiniChat on this device and shows it; it reports its own failure. */
  openLocal(): Promise<void>;
  /**
   * The provider's client for the machine's InfiniChat, made when there is none; two while the conversation moves from
   * one machine to another.
   */
  machine(machineId: string): RemoteInfiniChat;
  show(remote: RemoteInfiniChat): void;
  closeMachine(machineId: string): Promise<void>;
}

/**
 * This device's InfiniChat database files, by name, which a move copies: the page diffs' platform, and what else a
 * move does to them.
 */
export interface DatabaseFiles extends PagePlatform {
  /** SHA-256 and size, or undefined when the file isn't there. */
  describe(name: string): Promise<ConversationFile | undefined>;
  /**
   * Folds the WAL a close left into the closed database (`PRAGMA wal_checkpoint(TRUNCATE)`), so the database file alone
   * is the conversation; fails while it is still in use, and does nothing when it isn't there.
   */
  fold(name: string): Promise<void>;
  /** SQLite's backup API, from the open database to `to`, at the same page numbers. */
  backup(from: string, to: string): Promise<void>;
  /** Renames a closed database over `to`, removing both names' `-wal` and `-shm`. */
  rename(from: string, to: string): Promise<void>;
  /** Removes a database and its `-wal` and `-shm`. */
  remove(name: string): Promise<void>;
  /** A new, empty file a download writes into. */
  open(name: string): Promise<WritableStream<Uint8Array>>;
}

const same = (left: ConversationFile | undefined, right: ConversationFile | undefined) =>
  left?.sha256 === right?.sha256 && left?.size === right?.size;
/** The machine holds these files open: it adopted them, and the move there happened. */
const adopted = (held: ConversationState | undefined, files: ConversationFiles) => held?.active === true
  && same(held.adopted?.db, files.db);
/** "this iPhone" → "This iPhone", for a message that starts with the device. */
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The closed database, with its WAL folded in. The `-shm` index never moves: SQLite rebuilds it. */
async function localFiles(files: DatabaseFiles, device: string): Promise<ConversationFiles> {
  await files.fold(INFINICHAT_DATABASE);
  const db = await files.describe(INFINICHAT_DATABASE);
  if (!db) throw new Error(`${capitalized(device)} has no InfiniChat conversation to move.`);
  return { db };
}

/** Never shown: a move that can't patch copies the whole file, and a refresh changes nothing. */
const PATCH_FAILED = 'The patch failed.';
const COPY_INCOMPLETE = 'The SSH connection closed before the copy was complete.';

/** One copy's machine, through the environment the app borrows for it, and this device's files. */
interface Copy {
  machine: ExecutionEnv;
  files: DatabaseFiles;
  signal: AbortSignal;
  /** The machine's name, for messages. */
  name: string;
  /**
   * Finds this app's server bundle on the machine and the Node that `server.json` says runs it (listen.ts), for the
   * page commands, and fails the script when either is missing: nothing here installs one.
   */
  server: string[];
}

const run = (copy: Copy, lines: string[], failure: string, timeout?: null) =>
  runScript(copy.machine, copy.signal, copy.name, lines, { failure, timeout });

/**
 * Removes a patch step's `inputs` from the machine's home however the step ended, with what the server's commands left
 * beside them and beside its `outputs`: a command writes `<file>.<pid>` and renames it into place, and `diff --live`
 * backs the database up to `<patch>.<pid>.db` (server/pages.ts). A command stopped by an abort, a timeout or a lost
 * connection dies by SIGKILL, so its own `finally` never removes them. Not awaited, as machine.ts's `discard`.
 */
function discardPatch(copy: Copy, inputs: string[], outputs: string[] = []) {
  const files = [...inputs.map((path) => `"$HOME/${path}"`),
    ...[...inputs, ...outputs].map((path) => `"$HOME/${path}".*`)];
  void copy.machine.exec(`rm -f ${files.join(' ')}`, undefined, BACKGROUND_CONTEXT);
}

/** Writes `bytes` to the machine's `path` a chunk at a time, reporting the bytes written so far. */
async function copyTo(copy: Copy, path: string, bytes: Uint8Array, failure: string,
  onWritten: (bytes: number) => void) {
  const context = withAbortSignal(copy.signal, BACKGROUND_CONTEXT);
  for (let offset = 0; offset === 0 || offset < bytes.byteLength; offset += CHUNK) {
    const chunk = bytes.subarray(offset, offset + CHUNK);
    const written = offset === 0 ? await copy.machine.writeFile(path, chunk, context)
      : await copy.machine.appendFile(path, chunk, context);
    if (!written.ok) throw fileFailure(copy.signal, written.error, copy.name, failure);
    onWritten(offset + chunk.byteLength);
  }
}

/** Reads the machine's file at `path` into this device's file `name`, a chunk at a time, reporting its progress. */
async function copyFrom(copy: Copy, path: string, name: string, onCopied: (copied: Copied) => void) {
  const { machine, signal } = copy;
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  const incomplete = () => {
    signal.throwIfAborted();
    return new Error(COPY_INCOMPLETE);
  };
  const writer = (await copy.files.open(name)).getWriter();
  let reader: BinaryReader | undefined;
  try {
    const opened = await machine.openBinaryReader(path, undefined, context);
    if (!opened.ok) throw incomplete();
    reader = opened.value;
    const info = await reader.info(context);
    if (!info.ok) throw incomplete();
    const total = info.value.size;
    for (let bytes = 0; bytes < total;) {
      const read = await reader.read(bytes, CHUNK, context);
      if (!read.ok) throw incomplete();
      // A file that shrank since it was opened fails the check of what arrived.
      if (read.value.byteLength === 0) break;
      await writer.write(read.value);
      bytes += read.value.byteLength;
      onCopied({ bytes, total });
    }
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  } finally {
    await reader?.close(BACKGROUND_CONTEXT);
  }
}

/**
 * Sends this device's database `from` as a patch against the machine's copy at `base`, which the machine applies,
 * verifies and renames to `out`: the copy's page list comes down, and the patch goes up as the whole file would. It
 * fails when the machine has no copy or no server of this bundle. The page list and the patch wait in the machine's
 * InfiniChat folder, which the server's bundle being there shows to exist.
 */
async function sendPatch(copy: Copy, from: string, base: string, out: string, onCopied: (copied: Copied) => void) {
  const list = temporary(FOLDER, 'pages');
  const patch = temporary(FOLDER, 'patch');
  try {
    await run(copy, [...copy.server, 'umask 077', `"$node" "$js" pages "$HOME/${base}" "$HOME/${list}"`, PRINT_MARKER],
      PATCH_FAILED, null);
    const listed = await copy.machine.readBinaryFile(`~/${list}`, withAbortSignal(copy.signal, BACKGROUND_CONTEXT));
    if (!listed.ok) throw fileFailure(copy.signal, listed.error, copy.name, PATCH_FAILED);
    const bytes = await diff(copy.files, from, new Uint8Array(listed.value));
    await copyTo(copy, `~/${patch}`, bytes, PATCH_FAILED,
      (written) => onCopied({ bytes: written, total: bytes.byteLength }));
    await run(copy, [...copy.server, 'umask 077', `mkdir -p "$(dirname "$HOME/${out}")"`,
      `"$node" "$js" patch "$HOME/${base}" "$HOME/${patch}" "$HOME/${out}"`, PRINT_MARKER], PATCH_FAILED, null);
  } finally {
    discardPatch(copy, [list, patch], [out]);
  }
}

/**
 * Brings this device's copy `base` up to the machine's database with a patch, applied, verified and renamed to `out`:
 * the page list goes up, the machine diffs (with `live`, a backup of the database it holds open), and the patch comes
 * down. It fails when the machine has no server of this bundle, which it checks before writing into the machine's
 * InfiniChat folder.
 */
async function receivePatch(copy: Copy, live: boolean, base: string, out: string,
  onCopied: (copied: Copied) => void) {
  const list = temporary(FOLDER, 'pages');
  const patch = temporary(FOLDER, 'patch');
  try {
    await run(copy, [...copy.server, PRINT_MARKER], PATCH_FAILED);
    const written = await copy.machine.writeFile(`~/${list}`, await pages(copy.files, base),
      withAbortSignal(copy.signal, BACKGROUND_CONTEXT));
    if (!written.ok) throw fileFailure(copy.signal, written.error, copy.name, PATCH_FAILED);
    await run(copy, [...copy.server, 'umask 077', `"$node" "$js" diff "$HOME/${DATA}/${INFINICHAT_DATABASE}" `
      + `"$HOME/${list}" "$HOME/${patch}"${live ? ' --live' : ''}`, PRINT_MARKER], PATCH_FAILED, null);
    await copyFrom(copy, `~/${patch}`, TRANSFER, onCopied);
    await apply(copy.files, base, await copy.files.read(TRANSFER), out);
  } finally {
    discardPatch(copy, [list, patch]);
    await copy.files.remove(TRANSFER);
  }
}

/**
 * Puts this device's closed database into the machine's `data/incoming/`: as a patch against the machine's copy, or as
 * the whole file when there is no copy or the patch fails, written in place, then verified by SHA-256. Neither has a
 * timeout of its own: they end with the copy, the user's Cancel, or the environment's connection, which notices a dead
 * machine. A file cut short stays only until the next copy replaces it, since only a verified one is placed. Moving it
 * into `data/` is refused while the machine holds a conversation open; a database an earlier one left there is kept in
 * `released/`.
 */
async function upload(copy: Copy, files: ConversationFiles, onCopied: (copied: Copied) => void) {
  const failure = `Check the account’s home folder permissions and disk space on ${copy.name}.`;
  const incoming = `${DATA}/incoming/${INFINICHAT_DATABASE}`;
  try {
    await sendPatch(copy, INFINICHAT_DATABASE, COPY, incoming, onCopied);
  } catch {
    copy.signal.throwIfAborted();
    // The folder is made first under umask 077, as an install makes its folders: a write would make it with the
    // environment's default mode.
    await run(copy, ['umask 077', `mkdir -p "$(dirname "$HOME/${incoming}")"`, PRINT_MARKER], failure);
    await copyTo(copy, `~/${incoming}`, await copy.files.read(INFINICHAT_DATABASE), failure,
      (bytes) => onCopied({ bytes, total: files.db.size }));
    await run(copy, [HASH, `f="$HOME/${incoming}"`, `[ "$(hash "$f")" = ${files.db.sha256} ]`, 'chmod 600 "$f"',
      PRINT_MARKER], failure, null);
  }
  const db = `"$d/${INFINICHAT_DATABASE}"`;
  const [placed] = await run(copy, ['umask 077', `d="$HOME/${DATA}"`, 's="$HOME/.infinichat/state.json"', PRINT_MARKER,
    `if [ -f "$s" ] && grep -q '"active":true' "$s"; then echo active; exit 0; fi`,
    `if [ -e ${db} ]; then r="$HOME/.infinichat/released/$(date -u +%Y-%m-%dT%H-%M-%SZ)-$$"`,
    `  mkdir -p "$r"; mv ${db}* "$r/"; fi`,
    `rm -f ${db}-wal ${db}-shm`,
    `mv -f "$d/incoming/${INFINICHAT_DATABASE}" ${db}`, 'echo placed'], failure);
  if (placed === 'active') throw new Error(`InfiniChat is already open on ${copy.name}.`);
  if (placed !== 'placed') throw new Error(failure);
}

/**
 * Brings the database the machine named to this device's incoming copy: as a patch against the moved copy, or as the
 * whole file when there is no copy or the patch fails. Either is checked against what the machine named.
 */
async function download(copy: Copy, files: ConversationFiles, onCopied: (copied: Copied) => void) {
  await copy.files.remove(INCOMING);
  try {
    await receivePatch(copy, false, MOVED, INCOMING, onCopied);
    if (same(await copy.files.describe(INCOMING), files.db)) return;
  } catch {
    copy.signal.throwIfAborted();
  }
  await copyFrom(copy, `~/${DATA}/${INFINICHAT_DATABASE}`, INCOMING, onCopied);
  if (!same(await copy.files.describe(INCOMING), files.db)) {
    throw new Error(`The copy from ${copy.name} doesn’t match what InfiniChat left there. Try again.`);
  }
}

/**
 * Patches the machine's copy with a backup of this device's open conversation, which SQLite's backup API takes
 * consistently and at the same page numbers while the Harness goes on writing.
 */
async function refreshCopy(copy: Copy) {
  await copy.files.remove(BACKUP);
  try {
    await copy.files.backup(INFINICHAT_DATABASE, BACKUP);
    await sendPatch(copy, BACKUP, COPY, COPY, () => {});
  } finally {
    await copy.files.remove(BACKUP);
  }
}

/**
 * Moves InfiniChat's conversation between this device and a machine, or straight from one machine to another with
 * this device orchestrating, one move at a time, as upstream's session sync hands a session over (pi `replication`
 * branch, `packages/durable/test/sync-e2e.test.ts:143-171`): the giving side
 * closes its Harness, the files are copied, and the other side opens them, where pi-durable's recovery resumes the work
 * the close interrupted. Nothing drains or waits. The home record names each phase before the step that needs it, so
 * `resume` carries a move on after a relaunch or a failure. The copy is the one seam upstream's replication could
 * replace: `upload` and `download`, which send the pages that changed since the other side's copy, and `refresh`,
 * which keeps that copy fresh. It reaches a machine through the `ExecutionEnv` the app borrows from the owner of its
 * connection there, and never closes it; cancelling stops only the move's own operations.
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

  /**
   * `directory` gives a machine as the app knows it, `environment` its files and commands, and `device` names this
   * device in messages, such as "this iPhone". `bundle` is this app's server bundle (`serverBundle`).
   */
  constructor(private readonly home: InfiniChatHomeStore,
    private readonly directory: (machineId: string) => MachineDirectory,
    private readonly environment: (machineId: string) => Promise<ExecutionEnv>,
    private readonly files: DatabaseFiles, private readonly device: string, private readonly bundle: string,
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

  /** Moves the conversation to the machine, or to this device for `null`, from where it lives. */
  choose(machineId: string | null) {
    const home = this.home.getSnapshot();
    if (this.attempt || this.status) return;
    if (machineId !== null && home.home === 'phone') this.run(machineId, 'machine');
    else if (home.home === 'machine' && home.phase === 'there') {
      if (machineId === null) this.run(home.machineId, 'phone');
      else if (machineId !== home.machineId) this.run(machineId, 'machine', false, home.machineId);
    }
  }

  /** Carries a move on from the phase the home record keeps, at launch and when the app becomes active. */
  resume() {
    const home = this.home.getSnapshot();
    if (this.attempt || home.home !== 'machine' || home.phase === 'there') return;
    if (home.phase === 'moving-there') this.run(home.machineId, 'machine', false, home.from);
    else this.run(home.machineId, 'phone');
  }

  /**
   * Brings the copy the other side keeps up to date, at launch and when the app returns from the background, so the
   * next move has little to send: this device's moved copy while the machine holds the conversation, the copy on
   * `copyOn` while this device does, each from a backup of the open database. It writes only that copy, aside and
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
      try {
        const copy = await this.copy(machineId, controller.signal);
        if (home.home === 'phone') await refreshCopy(copy);
        else await receivePatch(copy, true, MOVED, MOVED, () => {});
      } catch {
        // The next move works without it.
      } finally {
        this.refreshing = undefined;
      }
    })();
  }

  /** Stops a refresh where it is, as the app going to the background does. */
  stopRefresh() {
    this.refreshing?.abort();
  }

  /** A machine removed from the app's list keeps no copy for this device to refresh. */
  forget(machineId: string) {
    const home = this.home.getSnapshot();
    if (home.home === 'phone' && home.copyOn === machineId) this.home.set(PHONE_HOME);
  }

  /**
   * Brings the conversation back to this device from `machineId` before that machine is removed, since a move needs
   * its credentials: from `there` or a stopped move back, the move back runs; a move there is undone as Cancel undoes
   * it, then moved back if the machine had already adopted it. Resolves once the conversation isn't on that machine,
   * and rejects with the failure that stopped a move, which keeps its status as any failed move does.
   */
  async bringBack(machineId: string): Promise<void> {
    for (;;) {
      await this.running;
      const home = this.home.getSnapshot();
      if (home.home === 'phone' || home.machineId !== machineId) return;
      if (this.closed) throw new Error('InfiniChat closed.');
      // A move started meanwhile, from the header or a resume, finishes first.
      if (this.attempt) continue;
      const undo = home.phase === 'moving-there';
      this.run(machineId, undo ? 'machine' : 'phone', undo, undo ? home.from : undefined);
      await this.running;
      const error = this.status?.error;
      if (error !== undefined) throw new Error(error);
    }
  }

  /** Runs a move a failure stopped again, forward, also when the failure was a Cancel's. */
  retry() {
    const status = this.status;
    if (this.attempt || status?.error === undefined) return;
    this.run(status.machineId, status.to, false, status.from);
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
        if (home.home === 'phone') void this.sides.closeMachine(status.machineId);
        return;
      }
      this.run(status.machineId, status.to, true, status.from);
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

  private run(machineId: string, to: MoveStatus['to'], cancelling = false, from?: string) {
    // A move replaces the copies a refresh writes, so it waits until a refresh it stops has let go of them.
    this.stopRefresh();
    const refreshed = this.refreshed;
    const attempt = { controller: new AbortController(), cancelled: cancelling };
    this.attempt = attempt;
    this.machineClosed = false;
    this.notice = undefined;
    const origin = from === undefined ? {} : { from };
    this.status = { machineId, to, ...origin, step: to === 'machine' ? 'connecting' : 'closing', running: true,
      cancellable: !cancelling };
    this.notify();
    this.running = (async () => {
      await refreshed;
      if (!cancelling) {
        try {
          // A move that got this far finished: a Cancel too late to stop it changes nothing.
          const signal = attempt.controller.signal;
          await (to === 'phone' ? this.back(machineId, signal)
            : from === undefined ? this.there(machineId, signal) : this.between(from, machineId, signal));
          this.status = undefined;
          return;
        } catch (error) {
          if (this.closed) return;
          if (!attempt.cancelled) {
            const status = this.status ?? { machineId, to, ...origin, step: 'connecting', cancellable: true };
            this.status = { ...status, running: false, cancellable: true, error: this.failure(status, error) };
            return;
          }
        }
      }
      // Cancelled, with a new signal, which only closing aborts.
      attempt.controller = new AbortController();
      const step = this.status?.step ?? 'closing';
      this.status = { machineId, to, ...origin, step, running: true, cancellable: false, undoing: true };
      this.notify();
      try {
        await this.undo(machineId, to, attempt.controller.signal, from);
        this.status = undefined;
      } catch (error) {
        if (this.closed) return;
        const message = error instanceof Error ? error.message : String(error);
        this.status = { machineId, to, ...origin, step, running: false, cancellable: true, undoing: true,
          error: `The move could not be cancelled. ${message}` };
      }
    })().finally(() => {
      this.attempt = undefined;
      this.notify();
    });
  }

  /**
   * This device → machine. The machine runs this app's bundle before this device closes anything, so both sides run
   * the same pi-durable and no one-way migration runs on a copy the other side can't read. Until the machine has
   * adopted them, this device's files are the conversation; a machine that already holds them open finished the move.
   */
  private async there(machineId: string, signal: AbortSignal) {
    const remote = this.sides.machine(machineId);
    const name = this.name(machineId);
    await remote.connected(signal);
    if (this.home.getSnapshot().home === 'phone') {
      this.step({ step: 'closing' });
      this.home.set({ version: 1, home: 'machine', machineId, phase: 'moving-there' });
      this.sides.hold();
      await this.sides.closeLocal();
    }
    signal.throwIfAborted();
    const files = await localFiles(this.files, this.device);
    const held = remote.getConversation();
    if (!adopted(held, files)) {
      if (held?.active) throw new Error(`InfiniChat on ${name} already has another conversation open.`);
      this.machineClosed = true;
      this.step({ step: 'copying' });
      await upload(await this.copy(machineId, signal), files, (copied) => this.step({ step: 'copying', copied }));
      signal.throwIfAborted();
      this.machineClosed = false;
      this.step({ step: 'opening' }, false);
      await remote.adopt(files);
    }
    await this.arrived(machineId, remote);
  }

  /**
   * Machine → machine, this device orchestrating: the target runs this app's bundle first, the source closes the
   * conversation and names its files, the target pulls them over its own SSH and opens them, and the source keeps its
   * released copy. This device's own copy stays set aside, as it was under the source.
   */
  private async between(fromId: string, toId: string, signal: AbortSignal) {
    const source = this.sides.machine(fromId);
    const target = this.sides.machine(toId);
    // This device's connection to the target gives it its key, which the source lets in before the target's server
    // first looks for the source, so that never costs it a refused login.
    await awaitWithContext(this.environment(toId), withAbortSignal(signal, BACKGROUND_CONTEXT));
    await this.authorize(fromId, toId, signal);
    await target.connected(signal);
    this.step({ step: 'closing' });
    // A source that can't be reached can't hand the conversation on; it stays there, shown as it was.
    await source.connected(signal);
    const home = this.home.getSnapshot();
    if (home.home === 'machine' && home.phase === 'there') {
      this.home.set({ version: 1, home: 'machine', machineId: toId, phase: 'moving-there', from: fromId });
    }
    this.sides.hold();
    const files = await source.relinquish(this.holder(toId));
    signal.throwIfAborted();
    const held = target.getConversation();
    if (!adopted(held, files)) {
      if (held?.active) throw new Error(`InfiniChat on ${this.name(toId)} already has another conversation open.`);
      this.machineClosed = true;
      this.step({ step: 'copying' });
      const record = this.directory(fromId).machine();
      if (record === undefined) throw new Error(`${this.name(fromId)} is no longer among the machines.`);
      await target.pull(record, files);
      signal.throwIfAborted();
      this.machineClosed = false;
      this.step({ step: 'opening' }, false);
      await target.adopt(files);
    }
    await this.arrived(toId, target);
    // The released database stays the source's copy for a move back there; a machine that can't keep it sends the
    // whole file next time.
    await source.archive().catch(() => {});
    await this.sides.closeMachine(fromId);
  }

  /**
   * Lets the target into the source over the target's own SSH before it pulls: the target's InfiniChat key, which this
   * device learned when it connected there, goes into the source's `authorized_keys` as the key exchange puts it,
   * through the environment this device borrows for the source. A later connection to the source finds it there.
   */
  private async authorize(fromId: string, toId: string, signal: AbortSignal) {
    const key = this.directory(toId).machine()?.publicKey;
    const to = this.name(toId);
    if (key === undefined) {
      throw new Error(`Test ${to} in Remote machines first, so this device learns its InfiniChat key.`);
    }
    const from = this.name(fromId);
    const source = await awaitWithContext(this.environment(fromId), withAbortSignal(signal, BACKGROUND_CONTEXT));
    const [status] = await runScript(source, signal, from, keyExchangeLines([key], PRINT_MARKER),
      { failure: `${from} could not authorize ${to}’s InfiniChat key. Check its ssh-keygen and home folder.` });
    if (status !== 'ok') {
      throw new Error(`The SSH account on ${from} can neither write nor read its ~/.ssh/authorized_keys, so ${to} `
        + 'can’t be let in. Make that file the account’s own, then try again.');
    }
  }

  /** The machine as `relinquish` records who takes the conversation: by its endpoint, which every client knows. */
  private holder(machineId: string): InfiniChatClient {
    return { id: machineId, name: this.name(machineId) };
  }

  /** The machine holds the conversation: the record says so, and the screens show it there. */
  private async arrived(machineId: string, remote: RemoteInfiniChat) {
    this.home.set({ version: 1, home: 'machine', machineId, phase: 'there' });
    // Under either name this device's copy is never opened while the machine holds the conversation, and the next
    // move back replaces it.
    await this.files.rename(INFINICHAT_DATABASE, MOVED).catch(() => {});
    this.sides.show(remote);
  }

  /**
   * Machine → this device. The machine closes the conversation and names its files, which stay unchanged there until
   * `archive`, so a relaunch downloads them again and Cancel has the machine open them again.
   */
  private async back(machineId: string, signal: AbortSignal) {
    const remote = this.sides.machine(machineId);
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
    await download(await this.copy(machineId, signal), files, (copied) => this.step({ step: 'copying', copied }));
    signal.throwIfAborted();
    this.step({ step: 'opening' }, false);
    await this.files.rename(INCOMING, INFINICHAT_DATABASE);
    await this.files.remove(MOVED);
    // The placed files are the conversation now, and nothing has opened them, so the record names this device before
    // it opens them: a relaunch never downloads over work this device has done. The machine's copy is kept fresh from
    // now.
    this.home.set({ version: 1, home: 'phone', copyOn: machineId });
    await this.sides.openLocal();
    // A machine never opens released files, and the next move there sets them aside, so this may fail; the machine
    // then has no copy to refresh, and the next move there sends the whole file.
    await remote.archive().catch(() => {});
    await this.sides.closeMachine(machineId);
  }

  private async undo(machineId: string, to: MoveStatus['to'], signal: AbortSignal, from?: string) {
    const remote = this.sides.machine(machineId);
    const home = this.home.getSnapshot();
    if (to === 'machine' && from !== undefined) {
      await this.undoBetween(from, machineId, signal);
    } else if (to === 'machine') {
      if (home.home === 'machine' && home.phase === 'moving-there') {
        // This device's files are the conversation only while the machine never opened them. A machine that did (its
        // answer to `adopt` lost with the link) holds them now and may already be working, so finishing the move is
        // the only outcome that never opens the conversation twice.
        if (!this.machineClosed) {
          await remote.connected(signal);
          if (adopted(remote.getConversation(), await localFiles(this.files, this.device))) {
            await this.arrived(machineId, remote);
            this.notice = `InfiniChat had already opened on ${this.name(machineId)}, so the move finished and it `
              + `runs there now. Choose ${capitalized(this.device)} to move it back.`;
            return;
          }
        }
        this.home.set(PHONE_HOME);
        await this.sides.openLocal();
      }
      await this.sides.closeMachine(machineId);
    } else if (home.home === 'machine' && home.phase === 'moving-back') {
      // The machine's files are unchanged since it relinquished them, so it opens them again.
      await remote.connected(signal);
      if (!remote.getConversation()?.active) await remote.adopt(await remote.relinquish());
      this.home.set({ version: 1, home: 'machine', machineId, phase: 'there' });
      await this.files.remove(INCOMING);
      this.sides.show(remote);
    }
  }

  /**
   * Puts a move between machines back: the source opens the files it released, unless the target already holds them,
   * which finishes the move instead, as the undo of a move from this device does.
   */
  private async undoBetween(fromId: string, toId: string, signal: AbortSignal) {
    const home = this.home.getSnapshot();
    if (home.home === 'machine' && home.phase === 'moving-there' && home.machineId === toId) {
      const source = this.sides.machine(fromId);
      const target = this.sides.machine(toId);
      await source.connected(signal);
      // Named again, unchanged since the source released them.
      const files = await source.relinquish(this.holder(toId));
      if (!this.machineClosed) {
        await target.connected(signal);
        if (adopted(target.getConversation(), files)) {
          await this.arrived(toId, target);
          this.notice = `InfiniChat had already opened on ${this.name(toId)}, so the move finished and it runs `
            + 'there now.';
          await source.archive().catch(() => {});
          await this.sides.closeMachine(fromId);
          return;
        }
      }
      await source.adopt(files);
      this.home.set({ version: 1, home: 'machine', machineId: fromId, phase: 'there' });
      this.sides.show(source);
    }
    await this.sides.closeMachine(toId);
  }

  /** The machine's files and commands for a copy, borrowed from their owner; a cancel stops waiting for them. */
  private async copy(machineId: string, signal: AbortSignal): Promise<Copy> {
    const machine = await awaitWithContext(this.environment(machineId), withAbortSignal(signal, BACKGROUND_CONTEXT));
    const server = [`js="$HOME/${FOLDER}/server/${this.bundle}/server.js"`, '[ -f "$js" ]',
      `s="$HOME/${FOLDER}/server.json"`, `node=$(${NODE})`, '[ -n "$node" ]'];
    return { machine, files: this.files, signal, name: this.name(machineId), server };
  }

  private name(machineId: string): string {
    return this.directory(machineId).machine()?.name ?? 'the machine';
  }

  /** Names the step that failed, then why. */
  private failure(status: Pick<MoveStatus, 'machineId' | 'to' | 'step' | 'from'>, error: unknown): string {
    const name = this.name(status.machineId);
    const there = status.to === 'machine';
    const from = status.from === undefined ? this.device : this.name(status.from);
    const copying = status.from === undefined ? `Copying InfiniChat ${there ? 'to' : 'from'} ${name} failed.`
      : `Copying InfiniChat from ${from} to ${name} failed.`;
    const step = status.step === 'connecting' ? `Connecting to ${name} failed.`
      : status.step === 'closing' ? `Closing InfiniChat on ${there ? from : name} failed.`
        : status.step === 'copying' ? copying
          : `Opening InfiniChat on ${there ? name : this.device} failed.`;
    return `${step} ${error instanceof Error ? error.message : String(error)}`;
  }

  private step(update: Pick<MoveStatus, 'step' | 'copied'>, cancellable = true) {
    const status = this.status;
    if (!status || this.closed) return;
    this.status = { machineId: status.machineId, to: status.to,
      ...(status.from === undefined ? {} : { from: status.from }), running: true, cancellable, ...update };
    this.notify();
  }

  private notify() {
    for (const listener of [...this.listeners]) listener();
  }
}
