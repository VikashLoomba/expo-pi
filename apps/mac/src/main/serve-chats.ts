import type { Ctx, FacetHost } from '@earendil-works/chord';
import type { DurableChatService } from '@pi-agent/infinichat/pi/chat-service';
import { findCatalogModel, type ImageInput } from '@pi-agent/infinichat/pi/model-catalog';
import { Utils } from 'electrobun/main';

import { MacAccount, MacChat, MacChats, type ChatSummaryRecord, type MacPrincipal } from '../contract';
import type { MacAccount as Account } from './account';
import { Attachments } from './attachments';
import type { MacChats as Chats } from './chats';
import { listFolder, searchFolders } from './folders';
import type { MacMachines } from './machines';
import { done, mirror } from './serve';

const NOT_OPEN = 'The chats are not open on this Mac.';

/**
 * A call's cancellation, by its caller or its object's end (chord `docs/design.md` §6, "Ending"), for the work that
 * takes a signal; a `Context` types it as optional.
 */
const signalOf = (ctx: Ctx<MacPrincipal>) => ctx.abortSignal ?? new AbortController().signal;

/**
 * Serves this Mac's chats to the windows as `serve-infinichat.ts` serves InfiniChat: the list and the account as
 * members over their stores, and each shown chat as an object of its own whose members mirror the service's
 * `ChatView`. The object subscribes the view, which attaches pi-durable's conversation view at the first subscriber
 * and detaches at the last, and it lives while a window holds the chat (chord `docs/design.md` §6, "Lifetime follows
 * from kind and params"), so the view does too.
 */
export function serveChats(host: FacetHost<MacPrincipal>, chats: Chats, account: Account,
  machines: MacMachines): void {
  const attachments = new Attachments(chats.images);
  const open = (): DurableChatService => {
    const service = chats.service;
    if (service === undefined) throw new Error(chats.getError() ?? NOT_OPEN);
    return service;
  };
  const key = (id: string) => {
    const found = open().findChat(id);
    if (found === undefined) throw new Error('This chat is no longer available.');
    return found;
  };

  host.serve(MacChats, (_params, _principal, self) => {
    const list = mirror(self, [chats], () => ({
      chats: chats.getChats() ?? null, report: chats.getError() ?? null,
    }));
    return {
      variant: 'owner',
      members: {
        // The contract's own type of a row: a JSON value, which the service's interface is not by its type.
        chats: self.derive([list], ([value]): ChatSummaryRecord[] | null => value.chats),
        report: self.derive([list], ([value]) => value.report),
        createChat: async () => ({ id: String(await open().createChat()) }),
        rename: async ({ id, title }) => done(open().renameChat(key(id), title)),
        delete: async ({ id }) => done(open().deleteChat(key(id))),
        dismissError: async () => done(chats.dismissError()),
      },
    };
  });

  host.serve(MacChat, ({ id }, _principal, self) => {
    const service = chats.service;
    const found = service?.findChat(id);
    const view = service !== undefined && found !== undefined ? service.chat(found, { transcript: true }) : undefined;
    const chat = () => {
      if (service === undefined || found === undefined) throw new Error(chats.getError() ?? NOT_OPEN);
      return { service, id: found };
    };
    const shown = mirror(self, view === undefined ? [] : [view], () => ({
      snapshot: { view: view?.getSnapshot() ?? { status: 'missing' as const } },
      controls: view?.getControls() ?? null,
      messages: view?.getMessages() ?? [],
    }));
    /** The chat's model's image limits (the phone's `photo-attachments.ts`), from this Mac's catalog. */
    const imageLimits = (): ImageInput => {
      const settings = view?.getControls()?.settings;
      const model = settings === undefined ? undefined : findCatalogModel(account.getCatalog(), settings.model);
      if (model === undefined) throw new Error('Choose this chat’s model in its settings to attach a photo.');
      if (model.images === undefined) throw new Error(`${model.name} does not accept images.`);
      return model.images;
    };
    return {
      variant: 'owner',
      members: {
        snapshot: self.derive([shown], ([value]) => value.snapshot),
        controls: self.derive([shown], ([value]) => value.controls),
        // Chord's JSON arrays are mutable types; the copy keeps its elements, which the diff compares by identity.
        messages: self.derive([shown], ([value]) => [...value.messages]),
        send: async ({ content, requestId }) => done(chat().service.send(chat().id, content, requestId)),
        cancel: async () => done(chat().service.cancel(chat().id)),
        steer: async ({ submissionId, content }) =>
          done(chat().service.steerQueued(chat().id, submissionId, content)),
        continue: async () => done(chat().service.continue(chat().id)),
        loadEarlier: async () => done(view?.loadEarlier()),
        fillGap: async (gap) => done(view?.fillGap(gap)),
        updateSettings: async ({ settings }) => done(chat().service.updateSettings(chat().id, settings)),
        updateExecution: async ({ execution, settings }) =>
          done(chat().service.updateExecution(chat().id, execution, settings)),
        listFolder: async ({ machineId, path }, ctx) => {
          const signal = signalOf(ctx);
          return listFolder(await machines.environment(machineId, signal), path, signal);
        },
        searchFolders: async ({ machineId, root, query }, ctx) => {
          const signal = signalOf(ctx);
          return searchFolders(await machines.environment(machineId, signal), root, query, signal);
        },
        chooseLocalFolder: async () => {
          const [path] = await Utils.openFileDialog({
            canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false,
          });
          return path ?? null;
        },
        pickPhotos: async () => attachments.pick(imageLimits()),
        attach: async ({ mimeType, data }) => attachments.fit(Buffer.from(data, 'base64'), mimeType, imageLimits()),
      },
    };
  });

  host.serve(MacAccount, (_params, _principal, self) => {
    const shown = mirror(self, [account, account.credentials, account.signIn], () => ({
      catalog: account.getCatalog(),
      access: account.credentials.getSnapshot().providers,
      signInAttempt: account.signIn.getSnapshot(),
    }));
    return {
      variant: 'owner',
      members: {
        catalog: self.derive([shown], ([value]) => value.catalog),
        access: self.derive([shown], ([value]) => value.access),
        signInAttempt: self.derive([shown], ([value]) => value.signInAttempt),
        refreshCatalog: async () => done(account.refreshCatalog()),
        signIn: async ({ providerId }) => account.signIn.signIn(providerId),
        answer: async ({ promptId, value }) => done(account.signIn.answer(promptId, value)),
        cancelSignIn: async () => done(account.signIn.cancel()),
        setApiKey: async ({ providerId, key }) => done(account.signIn.setApiKey(providerId, key)),
        signOut: async ({ providerId }) => done(account.signIn.signOut(providerId)),
      },
    };
  });
}
