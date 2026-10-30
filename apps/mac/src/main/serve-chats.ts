import type { Host } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import { ChatControlsSchema } from '@pi-agent/infinichat/chat/types';
import type { DurableChatService } from '@pi-agent/infinichat/pi/chat-service';
import {
  AccessSchema, MessagesSchema, SignInAttemptSchema, SnapshotSchema,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { findCatalogModel, ModelCatalogSchema, type ImageInput } from '@pi-agent/infinichat/pi/model-catalog';
import { Utils } from 'electrobun/main';

import { ChatSummarySchema, MacAccount, MacChat, MacChats, type MacPrincipal } from '../contract';
import type { MacAccount as Account } from './account';
import { Attachments } from './attachments';
import type { MacChats as Chats } from './chats';
import { listFolder, searchFolders } from './folders';
import type { MacMachines } from './machines';

const ChatsCell = Type.Union([Type.Null(), Type.Array(ChatSummarySchema)]);
const ReportCell = Type.Union([Type.Null(), Type.String()]);
const ControlsCell = Type.Union([ChatControlsSchema, Type.Null()]);
const NOT_OPEN = 'The chats are not open on this Mac.';

/**
 * Serves this Mac's chats to the windows as `serve-infinichat.ts` serves InfiniChat: the list and the account as
 * cells over their stores, and each shown chat as an object of its own whose cells mirror the service's `ChatView`.
 * The object subscribes the view, which attaches pi-durable's conversation view at the first subscriber and
 * detaches at the last, so the view lives exactly while a window holds the chat (chord guide "Lifetime").
 */
export function serveChats(host: Host<MacPrincipal>, chats: Chats, account: Account, machines: MacMachines): void {
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

  host.serve(MacChats, (_input, _principal, self) => {
    const list = self.state('chats', ChatsCell, { init: () => chats.getChats() ?? null });
    const report = self.state('report', ReportCell, { init: () => chats.getError() ?? null });
    self.on('chats', chats, (_change, ctx) => {
      list.replace(ctx, chats.getChats() ?? null, { diff: true });
      report.replace(ctx, chats.getError() ?? null, { diff: true });
    });
    return {
      variant: 'owner',
      chats: list,
      report,
      createChat: async () => ({ id: String(await open().createChat()) }),
      rename: ({ id, title }) => open().renameChat(key(id), title),
      delete: ({ id }) => open().deleteChat(key(id)),
      dismissError: () => { chats.dismissError(); },
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
    const currentSnapshot = () => ({ view: view?.getSnapshot() ?? { status: 'missing' as const } });
    const snapshot = self.state('snapshot', SnapshotSchema, { init: currentSnapshot });
    const controls = self.state('controls', ControlsCell, { init: () => view?.getControls() ?? null });
    const messages = self.state('messages', MessagesSchema, { init: () => view?.getMessages() ?? [] });
    if (view !== undefined) {
      self.on('view', view, (_change, ctx) => {
        messages.replace(ctx, view.getMessages(), { diff: true });
        controls.replace(ctx, view.getControls() ?? null, { diff: true });
        snapshot.replace(ctx, currentSnapshot(), { diff: true });
      });
    }
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
      snapshot,
      controls,
      messages,
      send: async ({ content, requestId }) => { await chat().service.send(chat().id, content, requestId); },
      cancel: () => chat().service.cancel(chat().id),
      steer: ({ submissionId, content }) => chat().service.steerQueued(chat().id, submissionId, content),
      retryParked: () => chat().service.retryParked(view?.getControls()?.parked ?? []),
      updateSettings: ({ settings }) => chat().service.updateSettings(chat().id, settings),
      updateExecution: ({ execution, settings }) => chat().service.updateExecution(chat().id, execution, settings),
      listFolder: async ({ machineId, path }, ctx) =>
        listFolder(await machines.environment(machineId, ctx.signal), path, ctx.signal),
      searchFolders: async ({ machineId, root, query }, ctx) =>
        searchFolders(await machines.environment(machineId, ctx.signal), root, query, ctx.signal),
      chooseLocalFolder: async () => {
        const [path] = await Utils.openFileDialog({
          canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false,
        });
        return path ?? null;
      },
      pickPhotos: () => attachments.pick(imageLimits()),
      attach: ({ mimeType, data }) => attachments.fit(Buffer.from(data, 'base64'), mimeType, imageLimits()),
    };
  });

  host.serve(MacAccount, (_input, _principal, self) => {
    const catalog = self.state('catalog', ModelCatalogSchema, { init: account.getCatalog });
    const access = self.state('access', AccessSchema, { init: () => account.credentials.getSnapshot().providers });
    const signInAttempt = self.state('signInAttempt', SignInAttemptSchema, { init: account.signIn.getSnapshot });
    self.on('catalog', account, (_change, ctx) => {
      catalog.replace(ctx, account.getCatalog(), { diff: true });
    });
    self.on('access', account.credentials, (_change, ctx) => {
      access.replace(ctx, account.credentials.getSnapshot().providers, { diff: true });
    });
    self.on('signIn', account.signIn, (_change, ctx) => {
      signInAttempt.replace(ctx, account.signIn.getSnapshot(), { diff: true });
    });
    return {
      variant: 'owner',
      catalog,
      access,
      signInAttempt,
      refreshCatalog: () => account.refreshCatalog(),
      signIn: ({ providerId }) => account.signIn.signIn(providerId),
      answer: ({ promptId, value }) => { account.signIn.answer(promptId, value); },
      cancelSignIn: () => { account.signIn.cancel(); },
      setApiKey: ({ providerId, key }) => account.signIn.setApiKey(providerId, key),
      signOut: ({ providerId }) => account.signIn.signOut(providerId),
    };
  });
}
