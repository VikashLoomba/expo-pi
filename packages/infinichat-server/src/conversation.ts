import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { Store } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import { FileSyncStateStore } from '@earendil-works/chord/sync';
import type { Storage } from '@earendil-works/pi-durable';
import { CODEMODE_TOOL_NAME } from '@earendil-works/pi-durable/codemode';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { backupDatabase, nodeStoreFiles } from '@pi-agent/infinichat/node/database-files';
import type { ConversationState, InfiniChatClient } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import {
  conversationHead, FOLDER, give, SYNC, take, type HandoverFolder, type StoreFiles,
} from '@pi-agent/infinichat/pi/infinichat-remote/sync';
import { convertConversation, LEGACY_DATABASE } from '@pi-agent/infinichat/pi/infinichat-convert';
import type { InfiniChatService } from '@pi-agent/infinichat/pi/infinichat-service';
import {
  INFINICHAT_DATABASE as DATABASE, infiniChatStorage, openInfiniChatStore,
} from '@pi-agent/infinichat/pi/infinichat-store';

import { readState, updateState } from './state';

const noop = () => {};
/** Where this machine keeps what its copy last shared with each folder, as p2 keeps `backup/<target>/`. */
const SYNCED = 'synced';

/**
 * Another machine's files through this machine's own SSH, the account's home there, its name and its endpoint, for a
 * pull.
 */
export interface PullSource { env: ExecutionEnv; home: string; name: string; endpoint: string }

/** The context's cancellation as the signal the transport takes; one that never fires when it has none. */
const signalOf = (context: Context): AbortSignal => context.abortSignal ?? new AbortController().signal;

/**
 * InfiniChat's conversation on this machine. One process owns a storage at a time (pi-durable README), so this
 * machine opens its store only while it holds the conversation: from `adopt`, which a client calls once this
 * machine's copy is the conversation, until `relinquish`. The store stays in `data/` in between, as this machine's
 * copy, which the next `pull` brings up to date. `state.json` keeps `active` across restarts, so a reboot reopens it,
 * and the phone a handover goes to, which every client reads. The operations run one at a time, also when several
 * clients call them. While something subscribes, it follows the open core's view, report, scheduled tasks and agents,
 * and also says when the core comes or goes.
 *
 * A move is Chord's session sync through a folder (`sync.ts`): `sync/` here is this machine's, which it uploads to
 * when it gives the conversation, and which a phone, or a machine that took the conversation from it, uploads to when
 * it gives it to this machine.
 */
export class ServerConversation {
  private core?: InfiniChatService;
  /** The open core's store, which this closes once the core, whose Harness closes only its own storage in it, has. */
  private store?: Store;
  private state: ConversationState;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private unfollow = noop;
  private readonly data: string;
  private readonly files: StoreFiles;
  /** This machine's InfiniChat folder as Chord's sync reads and writes it, as p2 gives its backup the data folder. */
  private readonly disk: NodeExecutionEnv;

  /** `loaded` is the host's (`ServerProcess.loaded`): the core's Harness resumes once it settles. */
  constructor(private readonly home: string,
    private readonly openCore: (storage: Storage) => Promise<InfiniChatService>,
    private readonly loaded: Promise<void>) {
    this.data = join(home, 'data');
    this.files = nodeStoreFiles(this.data, join(home, 'released'));
    this.disk = new NodeExecutionEnv({ cwd: home });
    const { active, head, heldBy } = readState(home);
    this.state = { active, ...(head === undefined ? {} : { head }), ...(heldBy === undefined ? {} : { heldBy }) };
  }

  /** The core while this machine holds the conversation open. */
  get current(): InfiniChatService | undefined {
    return this.core;
  }

  readonly getState = () => this.state;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.follow();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      this.unfollow();
      this.unfollow = noop;
    };
  };

  /**
   * Opens the conversation when this machine held it when it last stopped, backing it up first when another release
   * opened it last (`backUp`).
   */
  start(): Promise<void> {
    return this.run(async () => {
      // For this account alone, as `data/` is: what a phone's upload makes inside has its environment's mode.
      await mkdir(join(this.home, SYNC), { recursive: true, mode: 0o700 });
      if (!this.state.active) return;
      if (readState(this.home).opened !== INFINICHAT_SERVER_VERSION) await this.backUp();
      await this.open();
    });
  }

  /**
   * Opens this machine's copy, which a `pull` brought to `head`, and holds the conversation from then on;
   * pi-durable's recovery then resumes the work the giver's close interrupted. Refused while this machine holds it,
   * and when its copy does not end where the giver said the conversation does. `active` is kept first, so a crash
   * while opening reopens it at the restart. It ends a handover this machine started, as Cancel's undo opens the
   * store it released.
   */
  adopt(head: number): Promise<void> {
    return this.run(async () => {
      if (this.state.active) throw new Error('InfiniChat is already open on this machine.');
      if (await conversationHead(this.files) !== head) {
        throw new Error('This machine’s copy is not the conversation that was sent. Try again.');
      }
      this.setState({ active: true, head });
      try {
        await this.open();
      } catch (error) {
        this.setState({ active: false });
        throw error;
      }
    });
  }

  /**
   * Starts a conversation of this machine's own, for a person whose InfiniChat is on no device yet: its database is
   * created in `data/` and held from then on. Refused while this machine holds one, while the one it held has gone to
   * a phone (`heldBy`), and while `data/` holds a database, which a move left: two conversations never merge, so a
   * second one is never started beside the first.
   */
  create(): Promise<void> {
    return this.run(async () => {
      if (this.state.active) throw new Error('InfiniChat is already open on this machine.');
      if (this.state.heldBy !== undefined) throw new Error(`InfiniChat is on ${this.state.heldBy.name}.`);
      if (this.files.exists(DATABASE) || this.files.exists(LEGACY_DATABASE)) {
        throw new Error('This machine already keeps an InfiniChat conversation.');
      }
      await mkdir(this.data, { recursive: true, mode: 0o700 });
      this.setState({ active: true });
      try {
        await this.open();
      } catch (error) {
        this.setState({ active: false });
        throw error;
      }
    });
  }

  /**
   * Hands the conversation to phone `to`: keeps it as `heldBy`, stops input at once, closes the core (its Harness waits
   * for running task code and writes the tasks it stopped back as pending) and its store, uploads what the store
   * committed since the folder last had it, and names where the conversation ends. Called again for the same phone,
   * it uploads nothing and names that again; for another, it is refused, so two clients never move the conversation
   * in two directions.
   *
   * The folder is this machine's own, unless `to` is the machine whose folder this copy was taken from: then it
   * goes back through that folder, which `reach` gives, and `folder` names that machine. Two machines that pass the
   * conversation between them so share one folder's history, and each move sends only what the other lacks; given
   * through its own folder, this copy would be one that folder has never held, and go whole. A machine that can't be
   * reached gets it through this machine's folder after all.
   */
  relinquish(to: InfiniChatClient, reach: (endpoint: string) => Promise<PullSource | undefined>,
  ): Promise<{ head: number; folder?: string }> {
    return this.run(async () => {
      const { heldBy } = this.state;
      if (heldBy !== undefined && heldBy.id !== to.id) {
        throw new Error(`InfiniChat is moving or has moved to ${heldBy.name}.`);
      }
      // Kept before the Harness closes, so whatever happens next, every client reads where it goes.
      if (heldBy === undefined) this.setState({ active: false, heldBy: to });
      if (this.core) await this.shut();
      if (!this.files.exists(DATABASE)) throw new Error('This machine holds no InfiniChat conversation.');
      // The handover goes on when the caller goes away, so nothing cancels the upload.
      const signal = signalOf(BACKGROUND_CONTEXT);
      const { through, syncId = randomUUID() } = readState(this.home);
      updateState(this.home, (kept) => ({ ...kept, syncId }));
      if (through === to.id) {
        try {
          const source = await reach(through);
          if (source) return { head: await give(this.files, syncId, this.folderOf(source, signal)), folder: through };
        } catch {
          // Through this machine's own folder, then.
        }
      }
      return { head: await give(this.files, syncId, this.folder(signal)) };
    });
  }

  /**
   * Brings this machine's copy to `head` from a folder: its own, which the giver uploaded to, or the one of the
   * machine that released the conversation, read over this machine's own SSH. The copy takes what the folder has
   * since the two last shared the conversation; where the folder does not continue from it, the whole store is
   * restored beside it and put in its place, and the copy it replaces is kept in `released/`. Which folder it was
   * is kept, for the next `relinquish`. Refused while this machine holds the conversation.
   */
  pull(source: PullSource | undefined, head: number, context: Context): Promise<void> {
    return this.run(async () => {
      if (this.state.active) throw new Error('InfiniChat is already open on this machine.');
      await mkdir(this.data, { recursive: true, mode: 0o700 });
      const signal = signalOf(context);
      await take(this.files, head, source === undefined ? this.folder(signal) : this.folderOf(source, signal));
      updateState(this.home, (kept) => ({ ...kept, through: source?.endpoint }));
    });
  }

  /** At shutdown: closes the core and keeps `active`, so the next start reopens it. */
  close(): Promise<void> {
    return this.run(() => this.shut());
  }

  /** Closes the core, then its store; the screens hear at once that the core is gone. */
  private async shut() {
    const { core, store } = this;
    this.core = undefined;
    this.store = undefined;
    this.changed();
    try {
      await core?.close();
    } finally {
      await store?.close(BACKGROUND_CONTEXT);
    }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(noop);
    return result;
  }

  /** This machine's own folder, on its own disk. */
  private folder(signal: AbortSignal): HandoverFolder {
    return { files: this.disk, root: SYNC, bookmarks: new FileSyncStateStore(this.disk, join(SYNCED, 'here')), signal };
  }

  /** Another machine's folder, through this machine's SSH there; what this copy shares with it is kept by endpoint. */
  private folderOf(source: PullSource, signal: AbortSignal): HandoverFolder {
    const key = createHash('sha256').update(source.endpoint).digest('hex').slice(0, 12);
    return { files: source.env, root: `${source.home}/${FOLDER}/${SYNC}`,
      bookmarks: new FileSyncStateStore(this.disk, join(SYNCED, key)), signal, machine: source.name };
  }

  /**
   * pi-durable migrates a document to the newer version a release reads when it first reads it, and an older
   * release then refuses it (its spec §3.6), as SQLite storage refuses a database a newer one migrated (§11.2): a
   * server update moves the conversation one way. So before a release first opens the database another one left,
   * this copies it to `backup/before-<release>/` with SQLite's online backup, which the release that left it can open
   * again; the copy replaces the one an earlier update made. A release from before the store left `infinichat.db`,
   * which is copied under that name, as that release opens it.
   */
  private async backUp() {
    const name = this.files.exists(DATABASE) ? DATABASE : LEGACY_DATABASE;
    const database = join(this.data, name);
    if (!this.files.exists(name)) return;
    const backups = join(this.home, 'backup');
    const target = join(backups, `before-${INFINICHAT_SERVER_VERSION}`);
    await rm(target, { recursive: true, force: true });
    await mkdir(target, { recursive: true, mode: 0o700 });
    await backupDatabase(database, join(target, name));
    for (const name of await readdir(backups)) {
      if (join(backups, name) !== target) await rm(join(backups, name), { recursive: true, force: true });
    }
  }

  /**
   * A conversation the releases before the store left in `infinichat.db`, pi-durable's own SQLite storage, becomes
   * the store, once: copied record by record (`convertConversation`) into a store aside, which takes the store's name
   * only when the copy is whole, so a conversion a stop cut off starts over. The old file then goes; `backUp` kept
   * it. With it goes what those releases kept beside it for a move that copied the file, which nothing reads now:
   * this machine's copy of a conversation it had handed on (`copy/`), and where an upload waited (`data/incoming/`).
   */
  private async convert() {
    if (this.files.exists(DATABASE) || !this.files.exists(LEGACY_DATABASE)) return;
    const aside = `${DATABASE}.converting`;
    await this.files.remove(aside);
    const from = await openNodeSqliteStorage(join(this.data, LEGACY_DATABASE));
    try {
      const store = await openInfiniChatStore(await this.files.open(aside), BACKGROUND_CONTEXT);
      try {
        const to = await infiniChatStorage(store, BACKGROUND_CONTEXT);
        await convertConversation(from, to, BACKGROUND_CONTEXT);
        await to.close(BACKGROUND_CONTEXT);
      } finally {
        await store.close(BACKGROUND_CONTEXT);
      }
    } finally {
      await from.close(BACKGROUND_CONTEXT);
    }
    // The rename takes the file alone, so its WAL is folded into it first.
    await this.files.fold(aside);
    await this.files.rename(aside, DATABASE);
    await this.files.remove(LEGACY_DATABASE);
    await rm(join(this.home, 'copy'), { recursive: true, force: true });
    await rm(join(this.data, 'incoming'), { recursive: true, force: true });
  }

  private async open() {
    await this.convert();
    const store = await openInfiniChatStore(await this.files.open(DATABASE), BACKGROUND_CONTEXT);
    let core: InfiniChatService;
    try {
      core = await this.openCore(await infiniChatStorage(store, BACKGROUND_CONTEXT));
    } catch (error) {
      // Whatever the Harness opened or closed in it, the store is this object's to close.
      await store.close(BACKGROUND_CONTEXT).catch(noop);
      throw error;
    }
    this.core = core;
    this.store = store;
    updateState(this.home, (kept) => ({ ...kept, opened: INFINICHAT_SERVER_VERSION }));
    this.changed();
    // Paused until every plugin's extensions are installed, which a start waits for and an adopt finds done, so a tool
    // call a restart cut off reruns instead of ending interrupted (durable `src/harness/tool.ts`, recovery). By then
    // the tools plugin has registered code mode, the one tool the model is offered: its scripts call the others.
    void this.loaded.then(async () => {
      if (this.core !== core) return;
      await core.offer(CODEMODE_TOOL_NAME).catch((error: unknown) => core.report(error));
      if (this.core === core) core.harness.resume();
    });
  }

  /** Keeps the conversation's state beside what the file keeps of this machine; a key without a value isn't written. */
  private setState(state: ConversationState) {
    this.state = state;
    updateState(this.home, ({ timeZone, opened, syncId, through }) =>
      ({ ...state, timeZone, opened, syncId, through }));
    this.changed();
  }

  /** Follows the new core, subscribing before letting the old one go, so a view kept open never detaches. */
  private changed() {
    if (this.listeners.size) this.follow();
    this.notify();
  }

  private follow() {
    const previous = this.unfollow;
    const core = this.core;
    if (core) {
      const stops = [core.view().subscribe(this.notify), core.subscribe(this.notify),
        core.scheduled.subscribe(this.notify), core.machines.subscribe(this.notify),
        core.agents.subscribe(this.notify)];
      this.unfollow = () => {
        for (const stop of stops) stop();
      };
    } else {
      this.unfollow = noop;
    }
    previous();
  }

  private readonly notify = () => {
    for (const listener of [...this.listeners]) listener();
  };
}
