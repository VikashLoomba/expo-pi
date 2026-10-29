import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Storage } from '@earendil-works/pi-durable';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import type { ImageProcessor } from '@earendil-works/pi-durable/tools';
import type { ChatSummary } from '@pi-agent/infinichat/chat/types';
import { DurableChatService } from '@pi-agent/infinichat/pi/chat-service';
import { NEW_CHAT_DEFAULTS } from '@pi-agent/infinichat/pi/new-chat';
import { Utils } from 'electrobun/main';

import type { MacAccount } from './account';
import type { MacMachines } from './machines';

const DATABASE = 'chats.db';
const noop = () => {};
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * This Mac's own chats: `DurableChatService` over a SQLite file in the app's data, opened as the phone's provider
 * opens it (`chat-provider.tsx`), with each chat's tools in a folder of its own under `chats/` (pi-durable's example
 * 29: "a sandbox is a directory") or on a machine over the pooled pi-env connection. Opening and closing run in
 * order; a storage failure closes the Harness and the service reopens (pi-durable README "Errors").
 */
export class MacChats {
  private current?: DurableChatService;
  private openError?: string;
  private queue: Promise<void> = Promise.resolve();
  private unfollow = noop;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly folders = join(Utils.paths.userData, 'chats');

  /** `images` also fits the composer's photos to a chat's model (`serve-chats.ts`). */
  constructor(private readonly account: MacAccount, private readonly machines: MacMachines,
    readonly images: ImageProcessor) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** The service while it is open; the windows' objects resolve their chats through it. */
  get service(): DurableChatService | undefined {
    return this.current;
  }
  readonly getChats = (): ChatSummary[] | undefined => this.current?.getSnapshot().chats;
  /** A failed open, else the Harness's latest report. */
  readonly getError = (): string | undefined => this.openError ?? this.current?.getSnapshot().error;

  /** Opens the chats; an open service ignores the call. */
  open(): void {
    this.serialize(async () => {
      if (this.current !== undefined || this.closed) return;
      // Release the database when its service does not open, so a later attempt never holds two connections.
      let storage: Storage | undefined;
      try {
        storage = await openNodeSqliteStorage(join(Utils.paths.userData, DATABASE));
        const opened = await DurableChatService.open({
          storage, models: this.account.models, images: this.images, newChat: NEW_CHAT_DEFAULTS,
          authError: this.account.authError,
          local: {
            // A fresh environment per use needs no cleanup (pi-durable README "Environment"); the folder is made so
            // the first command has somewhere to run. Any folder may be chosen for a chat on this Mac.
            environment: (id, cwd) => {
              mkdirSync(this.folder(id), { recursive: true });
              return new NodeExecutionEnv({ cwd: cwd ?? this.folder(id) });
            },
            remove: (id) => rmSync(this.folder(id), { recursive: true, force: true }),
            root: null,
          },
          machines: { environment: (id, cwd) => this.machines.environment(id, new AbortController().signal, cwd) },
          onClosed: (end) => {
            if (end.reason !== 'failed') return;
            this.serialize(async () => {
              if (this.current !== opened) return;
              this.current = undefined;
              this.unfollow();
              await opened.close().catch(noop);
            });
            this.open();
          },
        });
        this.current = opened;
        this.openError = undefined;
        this.unfollow = opened.subscribe(this.notify);
      } catch (error) {
        await storage?.close(BACKGROUND_CONTEXT).catch(noop);
        this.openError = errorText(error);
      }
      this.notify();
    });
  }

  dismissError(): void {
    this.openError = undefined;
    this.current?.dismissError();
    this.notify();
  }

  /** At quit, before the machines' connections, which the chats' tools use. */
  close(): Promise<void> {
    this.closed = true;
    return this.serialize(async () => {
      const closing = this.current;
      this.current = undefined;
      this.unfollow();
      this.unfollow = noop;
      await closing?.close();
    });
  }

  private folder(workspaceId: string): string {
    return join(this.folders, workspaceId);
  }

  private serialize(step: () => Promise<void>): Promise<void> {
    const result = this.queue.then(step);
    this.queue = result.catch(noop);
    return result;
  }

  private readonly notify = () => {
    for (const listener of [...this.listeners]) listener();
  };
}
