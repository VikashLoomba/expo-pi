import { mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Storage } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { nodeDatabaseFiles } from '@pi-agent/infinichat/node/database-files';
import type { ConversationFiles, ConversationState } from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import type { InfiniChatService } from '@pi-agent/infinichat/pi/infinichat-service';

import { readState, updateState } from './state';

const noop = () => {};
const DATABASE = 'infinichat.db';
type ConversationFile = ConversationFiles['db'];

const same = (left: ConversationFile | undefined, right: ConversationFile | undefined) =>
  left?.sha256 === right?.sha256 && left?.size === right?.size;

/**
 * InfiniChat's conversation on this machine. One process owns a storage at a time (pi-durable README), so this
 * machine opens its database only while it holds the conversation: from `adopt`, which the phone calls once it has
 * copied its files here, until `relinquish`. `state.json` keeps `active` across restarts, so a reboot reopens it. The
 * operations run one at a time. While something subscribes, it follows the open core's view, report and scheduled
 * tasks, and also says when the core comes or goes.
 */
export class ServerConversation {
  private core?: InfiniChatService;
  private state: ConversationState;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private unfollow = noop;
  private readonly data: string;

  constructor(private readonly home: string,
    private readonly openCore: (storage: Storage) => Promise<InfiniChatService>) {
    this.data = join(home, 'data');
    const { active, adopted } = readState(home);
    this.state = { active, ...(adopted === undefined ? {} : { adopted }) };
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

  /** Opens the conversation when this machine held it when it last stopped. */
  start(): Promise<void> {
    return this.run(async () => {
      if (this.state.active) await this.open();
    });
  }

  /**
   * Opens the files the phone copied to `data/` and holds the conversation from then on; pi-durable's recovery then
   * resumes the work the phone's close interrupted. Refused while this machine holds it, and when the files differ
   * from the ones the phone verified. `active` is kept first, so a crash while opening reopens them at the restart.
   */
  adopt(files: ConversationFiles): Promise<void> {
    return this.run(async () => {
      if (this.state.active) throw new Error('InfiniChat is already open on this machine.');
      const found = await this.files();
      if (!same(found?.db, files.db)) {
        throw new Error('The copied conversation does not match the one this iPhone sent. Try again.');
      }
      this.setState({ active: true, adopted: files });
      try {
        await this.open();
      } catch (error) {
        this.setState({ active: false });
        throw error;
      }
    });
  }

  /**
   * Stops input at once, closes the core (its Harness waits for running task code and writes the tasks it stopped back
   * as pending) and its storage, folds its WAL, and names the database it left in `data/`. Called again, it names it
   * again.
   */
  relinquish(): Promise<ConversationFiles> {
    return this.run(async () => {
      const core = this.core;
      if (core) {
        this.core = undefined;
        this.changed();
        await core.close();
      }
      if (this.state.active) this.setState({ active: false });
      await nodeDatabaseFiles.fold(join(this.data, DATABASE));
      const files = await this.files();
      if (!files) throw new Error('This machine holds no InfiniChat conversation.');
      return files;
    });
  }

  /**
   * Moves the released database to `copy/`, replacing the copy there, where nothing opens it: the phone's next move
   * here patches it, and the phone keeps it fresh meanwhile. Refused while holding it.
   */
  archive(): Promise<void> {
    return this.run(async () => {
      if (this.state.active) throw new Error('InfiniChat is open on this machine.');
      await mkdir(join(this.home, 'copy'), { recursive: true, mode: 0o700 });
      try {
        await rename(join(this.data, DATABASE), join(this.home, 'copy', DATABASE));
      } catch (error) {
        // Archived already.
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    });
  }

  /** At shutdown: closes the core and keeps `active`, so the next start reopens it. */
  close(): Promise<void> {
    return this.run(async () => {
      const core = this.core;
      this.core = undefined;
      this.changed();
      await core?.close();
    });
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(noop);
    return result;
  }

  private async files(): Promise<ConversationFiles | undefined> {
    const db = await nodeDatabaseFiles.describe(join(this.data, DATABASE));
    return db && { db };
  }

  private async open() {
    const storage = await openNodeSqliteStorage(join(this.data, DATABASE));
    try {
      this.core = await this.openCore(storage);
    } catch (error) {
      // The Harness closes its storage; this closes it when the Harness never opened.
      await storage.close(BACKGROUND_CONTEXT).catch(noop);
      throw error;
    }
    this.changed();
  }

  private setState(state: ConversationState) {
    this.state = state;
    updateState(this.home, ({ timeZone }) => ({ ...state, ...(timeZone === undefined ? {} : { timeZone }) }));
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
        core.scheduled.subscribe(this.notify)];
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
