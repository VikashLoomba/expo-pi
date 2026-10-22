import type { Ctx, Host } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';

import {
  AccessSchema, ControlsSchema, ConversationSchema, InfiniChatRemote, MessagesSchema, ScheduledSchema, ServerSchema,
  SignInAttemptSchema, SnapshotSchema, type InfiniChatPrincipal, type InfiniChatServer,
} from '../src/pi/infinichat-remote/contract';
import { ModelCatalogSchema, type ModelCatalog } from '../src/pi/model-catalog';
import type { ProviderCredentialStore } from '../src/pi/provider-credentials';
import type { ServerConversation } from './conversation';
import type { ServerSignIn } from './sign-in';

/** A call's context for the core's own waits: the caller cancels the wait, never the work. */
const callContext = (ctx: Ctx<InfiniChatPrincipal>) => withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);
const LOADING = { status: 'loading' } as const;

/**
 * Serves the conversation as InfiniChat's remote object. Its cells mirror the open core's view, its latest report and
 * its scheduled tasks; the view's projection rebuilds its arrays on every update, so each write goes out as a diff.
 * While this machine doesn't hold the conversation, there is no core: the view is loading and the operations refuse.
 * `conversation` says whether it holds it, and `adopt`, `relinquish` and `archive` move it. `server` says which server
 * answers, and `setTimeZone` applies the phone's zone. The account cells mirror this machine's credential store and its
 * sign-in, which outlive the object, so a phone that reconnects finds them again; `catalog` is fixed, because none of
 * the registered providers refreshes its models (pi-ai `refreshModels`).
 */
export function serveInfiniChat(host: Host<InfiniChatPrincipal>, conversation: ServerConversation, options: {
  server: InfiniChatServer;
  setTimeZone(zone: string): void;
  catalog: ModelCatalog;
  credentials: ProviderCredentialStore;
  signIn: ServerSignIn;
}) {
  const { credentials, signIn } = options;
  const core = () => {
    const open = conversation.current;
    if (!open) throw new Error(`InfiniChat isn’t open on ${options.server.device}.`);
    return open;
  };
  host.serve(InfiniChatRemote, (_input, _principal, self) => {
    const currentSnapshot = () => {
      const open = conversation.current;
      if (!open) return { view: LOADING };
      const { error } = open.getSnapshot();
      return { view: open.view().getSnapshot(), ...(error === undefined ? {} : { report: error }) };
    };
    const currentControls = () => conversation.current?.view().getControls() ?? null;
    const currentMessages = () => conversation.current?.view().getMessages() ?? [];
    const currentScheduled = () => conversation.current?.scheduled.getSnapshot() ?? [];
    const snapshot = self.state('snapshot', SnapshotSchema, { init: currentSnapshot });
    const controls = self.state('controls', ControlsSchema, { init: currentControls });
    const messages = self.state('messages', MessagesSchema, { init: currentMessages });
    const scheduled = self.state('scheduled', ScheduledSchema, { init: currentScheduled });
    const held = self.state('conversation', ConversationSchema, { init: conversation.getState });
    const server = self.state('server', ServerSchema, { init: () => options.server });
    const catalog = self.state('catalog', ModelCatalogSchema, { init: () => options.catalog });
    const access = self.state('access', AccessSchema, { init: () => credentials.getSnapshot().providers });
    const signInAttempt = self.state('signInAttempt', SignInAttemptSchema, { init: () => signIn.getSnapshot() });
    self.on('access', credentials, (_change, ctx) => access.replace(ctx, credentials.getSnapshot().providers));
    self.on('signInAttempt', signIn, (_change, ctx) => signInAttempt.replace(ctx, signIn.getSnapshot()));
    // The open core's view attaches once this object follows it and publishes when it has read the conversation, so
    // every cell also catches up on what changed while the object went live, or while the core came or went. The
    // snapshot goes last: past Chord's flow-control window, each member's state waits in a slot of its own and the
    // slots flush in the order they were made (chord `docs/spec.md:242`, `:287`), so a `ready` written first could
    // reach the phone before the messages it describes, and the phone switches its screens on the first `ready`.
    self.on('conversation', conversation, (_change, ctx) => {
      messages.replace(ctx, currentMessages(), { diff: true });
      controls.replace(ctx, currentControls(), { diff: true });
      scheduled.replace(ctx, currentScheduled(), { diff: true });
      held.replace(ctx, conversation.getState(), { diff: true });
      snapshot.replace(ctx, currentSnapshot(), { diff: true });
    });
    return {
      variant: 'owner',
      snapshot,
      controls,
      messages,
      scheduled,
      conversation: held,
      server,
      catalog,
      access,
      signInAttempt,
      accept: ({ content, requestId }, ctx) => core().accept(content, requestId, callContext(ctx)),
      stop: () => core().stop(),
      updateSettings: ({ main, summary, instructions }, ctx) =>
        core().updateSettings(main, summary, instructions, callContext(ctx)),
      cancelScheduled: ({ id, replacement }, ctx) => core().cancelScheduled(id, replacement, callContext(ctx)),
      dismissError: () => core().dismissError(),
      setTimeZone: ({ zone }) => options.setTimeZone(zone),
      signIn: ({ providerId }) => signIn.signIn(providerId),
      answer: ({ promptId, value }) => signIn.answer(promptId, value),
      cancelSignIn: () => signIn.cancel(),
      setApiKey: ({ providerId, key }) => signIn.setApiKey(providerId, key),
      signOut: ({ providerId }) => signIn.signOut(providerId),
      // The move goes on when the caller goes away: a dropped link never leaves it half done.
      adopt: (files) => conversation.adopt(files),
      relinquish: () => conversation.relinquish(),
      archive: () => conversation.archive(),
    };
  });
}
