import type { Ctx, Host } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';

import {
  AccessSchema, ControlsSchema, InfiniChatRemote, MessagesSchema, ScheduledSchema, ServerSchema, SignInAttemptSchema,
  SnapshotSchema, type InfiniChatPrincipal, type InfiniChatServer,
} from '../src/pi/infinichat-remote/contract';
import type { InfiniChatService } from '../src/pi/infinichat-service';
import { ModelCatalogSchema, type ModelCatalog } from '../src/pi/model-catalog';
import type { ProviderCredentialStore } from '../src/pi/provider-credentials';
import type { ServerSignIn } from './sign-in';

/** A call's context for the core's own waits: the caller cancels the wait, never the work. */
const callContext = (ctx: Ctx<InfiniChatPrincipal>) => withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);

/**
 * Serves the core as InfiniChat's remote object. Its cells mirror the core's view, its latest report and its
 * scheduled tasks; the view's projection rebuilds its arrays on every update, so each write goes out as a diff.
 * `server` says which server answers, and `setTimeZone` applies the phone's zone. The account cells mirror this
 * machine's credential store and its sign-in, which outlive the object, so a phone that reconnects finds them again;
 * `catalog` is fixed, because none of the registered providers refreshes its models (pi-ai `refreshModels`).
 */
export function serveInfiniChat(host: Host<InfiniChatPrincipal>, core: InfiniChatService, options: {
  server: InfiniChatServer;
  setTimeZone(zone: string): void;
  catalog: ModelCatalog;
  credentials: ProviderCredentialStore;
  signIn: ServerSignIn;
}) {
  const { credentials, signIn } = options;
  host.serve(InfiniChatRemote, (_input, _principal, self) => {
    const view = core.view();
    const currentSnapshot = () => {
      const { error } = core.getSnapshot();
      return { view: view.getSnapshot(), ...(error === undefined ? {} : { report: error }) };
    };
    const snapshot = self.state('snapshot', SnapshotSchema, { init: currentSnapshot });
    const controls = self.state('controls', ControlsSchema, { init: () => view.getControls() ?? null });
    const messages = self.state('messages', MessagesSchema, { init: () => view.getMessages() });
    const scheduled = self.state('scheduled', ScheduledSchema, { init: () => core.scheduled.getSnapshot() ?? [] });
    const server = self.state('server', ServerSchema, { init: () => options.server });
    const catalog = self.state('catalog', ModelCatalogSchema, { init: () => options.catalog });
    const access = self.state('access', AccessSchema, { init: () => credentials.getSnapshot().providers });
    const signInAttempt = self.state('signInAttempt', SignInAttemptSchema, { init: () => signIn.getSnapshot() });
    self.on('access', credentials, (_change, ctx) => access.replace(ctx, credentials.getSnapshot().providers));
    self.on('signInAttempt', signIn, (_change, ctx) => signInAttempt.replace(ctx, signIn.getSnapshot()));
    const mirror = (_change: unknown, ctx: Ctx<InfiniChatPrincipal>) => {
      snapshot.replace(ctx, currentSnapshot(), { diff: true });
      controls.replace(ctx, view.getControls() ?? null, { diff: true });
      messages.replace(ctx, view.getMessages(), { diff: true });
      scheduled.replace(ctx, core.scheduled.getSnapshot() ?? [], { diff: true });
    };
    // The view attaches once this object follows it and publishes when it has read the conversation, so every cell
    // also catches up on what changed while the object went live.
    self.on('view', view, mirror);
    self.on('report', core, mirror);
    self.on('scheduled', core.scheduled, mirror);
    return {
      variant: 'owner',
      snapshot,
      controls,
      messages,
      scheduled,
      server,
      catalog,
      access,
      signInAttempt,
      accept: ({ content, requestId }, ctx) => core.accept(content, requestId, callContext(ctx)),
      stop: () => core.stop(),
      updateSettings: ({ main, summary, instructions }, ctx) =>
        core.updateSettings(main, summary, instructions, callContext(ctx)),
      cancelScheduled: ({ id, replacement }, ctx) => core.cancelScheduled(id, replacement, callContext(ctx)),
      dismissError: () => core.dismissError(),
      setTimeZone: ({ zone }) => options.setTimeZone(zone),
      signIn: ({ providerId }) => signIn.signIn(providerId),
      answer: ({ promptId, value }) => signIn.answer(promptId, value),
      cancelSignIn: () => signIn.cancel(),
      setApiKey: ({ providerId, key }) => signIn.setApiKey(providerId, key),
      signOut: ({ providerId }) => signIn.signOut(providerId),
    };
  });
}
