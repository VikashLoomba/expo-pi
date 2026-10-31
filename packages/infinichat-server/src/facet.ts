import { join } from 'node:path';

import { defineFacet, local, opaque, type Ctx } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { Type, type Models } from '@earendil-works/pi-ai';
import { fileCredentialBackend, openAILoginOptions } from '@pi-agent/infinichat/node/credentials';
import { serverDevices } from '@pi-agent/infinichat/node/devices';
import { ServerMachines } from '@pi-agent/infinichat/node/machines';
import { createServerModels } from '@pi-agent/infinichat/node/models';
import { ServerSignIn } from '@pi-agent/infinichat/node/sign-in';
import {
  AccessSchema, ControlsSchema, ConversationSchema, InfiniChatRemote, MachinesSchema, MessagesSchema,
  PendingHostKeysSchema, ReachSchema, ScheduledSchema, SignInAttemptSchema, SnapshotSchema,
  type InfiniChatPrincipal,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { InfiniChatService, infiniChatExtensions } from '@pi-agent/infinichat/pi/infinichat-service';
import { buildModelCatalog, ModelCatalogSchema } from '@pi-agent/infinichat/pi/model-catalog';
import { validateOpenAICredential } from '@pi-agent/infinichat/pi/openai-auth/core';
import {
  ProviderCredentialStore, type CredentialBackend,
} from '@pi-agent/infinichat/pi/provider-credentials';

import { ServerConversation } from './conversation';
import { InfiniChatProcess } from './process';
import { durableRegistry, Extensions } from './registry';
import { setTimeZone } from './state';
import { closeServerTools, openServerTools, serverToolSource } from './tools';

/** The credential store, its backend, and the models over it, which the Harness and the sign-in share. */
interface Account { backend: CredentialBackend; credentials: ProviderCredentialStore; models: Models }

/**
 * InfiniChat on this machine, one object of lifetime `"host"`, as chord's guide gives a host its Durable Harness
 * (`docs/guide.md` "Durable"): what outlives every client and plugin reload. Reload reconstructs registrations while
 * retaining these resources; a server release still restarts the process (`update.ts`). The
 * conversation's Harness reads its extensions from `Extensions`, which this object fills
 * with InfiniChat's and installed plugins with theirs. It opens the database only while this machine holds the
 * conversation (`ServerConversation`), so it holds the holder rather than the Harness itself.
 */
export const InfiniChatMachine = local('infinichat.machine', {
  version: 1,
  input: Type.Object({}),
  members: {
    account: opaque<Account>('infinichat.account@1'),
    signIn: opaque<ServerSignIn>('infinichat.sign-in@1'),
    machines: opaque<ServerMachines>('infinichat.machines@1'),
    conversation: opaque<ServerConversation>('infinichat.conversation@1'),
  },
});

/**
 * An exposed member, which Chord reads as `undefined` until its object is live (chord `src/object.ts`, `expose`).
 * Resources open, and methods and listeners run, only once the references they depend on are live, so it is set there.
 */
function live<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is not live yet.`);
  return value;
}

/** A call's context for the core's own waits: the caller cancels the wait, never the work. */
const callContext = (ctx: Ctx<InfiniChatPrincipal>) => withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);
const LOADING = { status: 'loading' } as const;

/** InfiniChat's built-in plugin, included in the same explicit reload as user-installed facets. */
export default defineFacet<InfiniChatPrincipal>((facet) => {
  facet.serve(InfiniChatMachine, (_input, _principal, self) => {
    const host = self.get(InfiniChatProcess, {});
    const proc = () => live(host.process, 'The host process');
    const account = self.resource('account', {
      version: 1,
      deps: [host],
      open: async () => {
        const { home, device } = proc();
        // pi-ai's own persistence seam: this machine's store; its file outlives the process.
        const backend = fileCredentialBackend(join(home, 'credentials.json'));
        const credentials = new ProviderCredentialStore(backend, { openai: { validate: validateOpenAICredential } },
          `Check that ~/.infinichat/credentials.json on ${device} can be read and written, then try again.`);
        const models = createServerModels(credentials);
        credentials.registerProviders(models.getProviders().map((provider) => provider.id));
        // A provider whose credential cannot be read reports it in its own access state.
        await credentials.restore().catch(() => {});
        // pi.dev's newer models before the Harness opens, so work it resumes finds a model pi-ai doesn't ship
        // (`chat-providers.ts`); each fetch waits at most pi's own 4 s, and a failed one keeps pi-ai's.
        await models.refresh();
        return { backend, credentials, models };
      },
    });
    const signIn = self.resource('signIn', {
      version: 1,
      deps: [account],
      open: () => new ServerSignIn(account.value.models, account.value.credentials,
        openAILoginOptions(account.value.backend)),
      // Ends an attempt still under way.
      close: (attempts) => attempts.cancel(),
    });
    // The other machines' connections, which the conversation's tools use; they close after it.
    const machines = self.resource('machines', {
      version: 1,
      deps: [host],
      open: () => new ServerMachines(proc().home, proc().device),
      close: (connections) => connections.close(),
    });
    // What the conversation's open core shows as its report, or the server's log while none is open.
    const report = (error: unknown) => {
      try {
        const current = conversation.value.current;
        if (current) {
          current.report(error);
          return;
        }
      } catch {
        // Resources are not yet live while the host object is activating.
      }
      console.error('InfiniChat:', error instanceof Error ? error.message : error);
    };
    // Code mode and the MCP servers, on by default; their connections and sandbox close after the conversation.
    const tools = self.resource('tools', {
      version: 1,
      deps: [host],
      open: () => openServerTools(proc().home, report),
      close: closeServerTools,
    });
    // What the Harness reads; a table pi-durable refuses shows as the conversation's report when it is open.
    const registry = self.resource('registry', {
      version: 1,
      deps: [tools],
      open: () => durableRegistry(facet.registry(Extensions), report),
      close: (reader) => reader.close(),
    });
    const conversation = self.resource('conversation', {
      version: 1,
      deps: [host, account, machines, registry],
      open: async () => {
        const { home, device } = proc();
        const held = new ServerConversation(home, (storage) => InfiniChatService.open({
          storage, models: account.value.models, parts, registry: registry.value, machine: device,
          onClosed: (end) => {
            if (end.reason === 'failed') proc().fail(end.error);
          },
        }));
        await held.start();
        return held;
      },
      // Closing waits for running task code; work it cuts off stays pending for the next open.
      close: (held) => held.close(),
    });
    // The machines are the open conversation's document; the connections follow it and outlive each hold.
    self.resource('follow', {
      version: 1,
      deps: [machines, conversation],
      open: () => machines.value.follow({
        subscribe: conversation.value.subscribe,
        current: () => conversation.value.current?.machines.getSnapshot(),
      }),
      close: (unfollow) => unfollow(),
    });
    // Built at every reload; the Harness reaches them through `Extensions`. They read the open conversation and the
    // machines when they run, which is only while the conversation is open.
    const parts = infiniChatExtensions(
      serverDevices(() => ({ name: proc().device, description: proc().description }),
        () => machines.value),
      () => conversation.value.current?.harness, (error) => conversation.value.current?.report(error));
    self.register(Extensions, {
      ...Object.fromEntries(parts.extensions.map((extension) => [extension.name, extension])),
      'infinichat.server-tools': serverToolSource(() => tools.value, () => proc().home),
    });
    return {
      account: self.expose(account),
      signIn: self.expose(signIn),
      machines: self.expose(machines),
      conversation: self.expose(conversation),
    };
  }, { lifetime: 'host' });

  /**
   * InfiniChat as clients hold it, one object every client shares (all act as the owner). Its cells mirror the open
   * core's view, its latest report and its scheduled tasks, while a client holds it; the view's projection rebuilds
   * its arrays on every update, so each write goes out as a diff. While this machine doesn't hold the conversation,
   * there is no core: the view is loading, the scheduled tasks are null and the operations refuse. `conversation`
   * says whether it holds it, or which phone it went to, and `adopt`, `relinquish` and `archive` move it. `server` says
   * which release answers, and `setTimeZone` applies the phone's zone. The account cells mirror this machine's
   * credential store and its sign-in; `catalog` is the machine's models, as fetched from pi.dev at start and again on
   * `refreshCatalog`. `reach` and `pendingHostKeys` mirror what this machine found of the other machines its tools
   * use, which any client trusts with `acceptHostKey`.
   */
  facet.serve(InfiniChatRemote, (_input, _principal, self) => {
    const machine = self.get(InfiniChatMachine, {});
    const host = self.get(InfiniChatProcess, {});
    const proc = () => live(host.process, 'The host process');
    // The machine object's own values, borrowed once it is live: their events reach the cells, and their owner
    // closes them.
    const borrow = <T>(name: string, value: T | undefined) => live(value, `InfiniChat's ${name}`);
    const account = self.resource('account', { version: 1, deps: [machine],
      open: () => borrow('account', machine.account) });
    const credentials = self.resource('credentials', { version: 1, deps: [machine],
      open: () => borrow('account', machine.account).credentials });
    const signIn = self.resource('signIn', { version: 1, deps: [machine],
      open: () => borrow('sign-in', machine.signIn) });
    const machines = self.resource('machines', { version: 1, deps: [machine],
      open: () => borrow('machines', machine.machines) });
    const conversation = self.resource('conversation', { version: 1, deps: [machine],
      open: () => borrow('conversation', machine.conversation) });
    const core = () => {
      const open = conversation.value.current;
      if (!open) throw new Error(`InfiniChat isn’t open on ${proc().device}.`);
      return open;
    };
    const currentSnapshot = () => {
      const open = conversation.value.current;
      if (!open) return { view: LOADING };
      const { error } = open.getSnapshot();
      return { view: open.view().getSnapshot(), ...(error === undefined ? {} : { report: error }) };
    };
    const currentControls = () => conversation.value.current?.view().getControls() ?? null;
    const currentMessages = () => conversation.value.current?.view().getMessages() ?? [];
    const currentScheduled = () => conversation.value.current?.scheduled.getSnapshot() ?? null;
    const currentMachines = () => conversation.value.current?.machines.getSnapshot() ?? null;
    const snapshot = self.state('snapshot', SnapshotSchema, { init: currentSnapshot });
    const controls = self.state('controls', ControlsSchema, { init: currentControls });
    const messages = self.state('messages', MessagesSchema, { init: currentMessages });
    const scheduled = self.state('scheduled', ScheduledSchema, { init: currentScheduled });
    const machineList = self.state('machines', MachinesSchema, { init: currentMachines });
    const held = self.state('conversation', ConversationSchema, { init: () => conversation.value.getState() });
    // This code's release: a derivation is made anew at every reload, where a cell would keep the last value.
    const server = self.derive([], () => ({ version: INFINICHAT_SERVER_VERSION }));
    const catalog = self.state('catalog', ModelCatalogSchema, { init: () => buildModelCatalog(account.value.models) });
    const access = self.state('access', AccessSchema, { init: () => credentials.value.getSnapshot().providers });
    const signInAttempt = self.state('signInAttempt', SignInAttemptSchema, { init: () => signIn.value.getSnapshot() });
    self.on('access', credentials, (_change, ctx) => access.replace(ctx, credentials.value.getSnapshot().providers));
    self.on('signInAttempt', signIn, (_change, ctx) => signInAttempt.replace(ctx, signIn.value.getSnapshot()));
    const reach = self.state('reach', ReachSchema, { init: () => machines.value.getReach() });
    const pendingHostKeys = self.state('pendingHostKeys', PendingHostKeysSchema,
      { init: () => machines.value.getPending() });
    self.on('machines', machines, (_change, ctx) => {
      reach.replace(ctx, machines.value.getReach());
      pendingHostKeys.replace(ctx, machines.value.getPending());
    });
    // The open core's view attaches once this object follows it and publishes when it has read the conversation, so
    // every cell also catches up on what changed while the object went live, or while the core came or went.
    // The snapshot goes last. Past Chord's flow-control window each member's state waits in a slot of its own, flushed
    // in the order the slots were made (chord `docs/spec.md:242`); with the snapshot first, the realistic
    // conversation's `ready` reached the phone before its 1,433 messages, and the phone switches its screens on the
    // first `ready`. Writing it last orders that first `ready` only because no snapshot slot is waiting then (the
    // server was inactive and the link idle): a later snapshot joins a slot already waiting, wherever it sits
    // (`src/connection.ts:466-495`). Chord guarantees order within one member's stream only (`docs/spec.md:287`).
    self.on('conversation', conversation, (_change, ctx) => {
      messages.replace(ctx, currentMessages(), { diff: true });
      controls.replace(ctx, currentControls(), { diff: true });
      scheduled.replace(ctx, currentScheduled(), { diff: true });
      machineList.replace(ctx, currentMachines(), { diff: true });
      held.replace(ctx, conversation.value.getState(), { diff: true });
      snapshot.replace(ctx, currentSnapshot(), { diff: true });
    });
    return {
      variant: 'owner',
      snapshot,
      controls,
      messages,
      scheduled,
      machines: machineList,
      conversation: held,
      server,
      catalog,
      access,
      signInAttempt,
      reach,
      pendingHostKeys,
      accept: ({ content, requestId }, ctx) => core().accept(content, requestId, callContext(ctx)),
      stop: () => core().stop(),
      updateSettings: (settings, ctx) => core().updateSettings(settings, callContext(ctx)),
      cancelScheduled: ({ id, replacement }, ctx) => core().cancelScheduled(id, replacement, callContext(ctx)),
      dismissError: () => core().dismissError(),
      setTimeZone: ({ zone }) => setTimeZone(proc().home, zone),
      reloadPlugins: () => proc().reloadPlugins(),
      signIn: ({ providerId }) => signIn.value.signIn(providerId),
      answer: ({ promptId, value }) => signIn.value.answer(promptId, value),
      cancelSignIn: () => signIn.value.cancel(),
      setApiKey: ({ providerId, key }) => signIn.value.setApiKey(providerId, key),
      signOut: ({ providerId }) => signIn.value.signOut(providerId),
      refreshCatalog: async (ctx) => {
        const models = account.value.models;
        const result = await models.refresh();
        catalog.replace(ctx, buildModelCatalog(models), { diff: true });
        if (result.errors.size) {
          throw new Error('Some provider models could not be refreshed. Existing models are still available.');
        }
      },
      // The move goes on when the caller goes away: a dropped link never leaves it half done.
      adopt: (files) => conversation.value.adopt(files),
      relinquish: ({ to }) => conversation.value.relinquish(to),
      archive: () => conversation.value.archive(),
      pull: async ({ from, files }, ctx) =>
        conversation.value.pull(await machines.value.environment(from), files, callContext(ctx)),
      putMachine: (record) => core().putMachine(record),
      patchMachine: ({ endpoint, patch }) => core().patchMachine(endpoint, patch),
      removeMachine: ({ endpoint }) => core().removeMachine(endpoint),
      acceptHostKey: async ({ endpoint, fingerprints }) => {
        const hostKey = await machines.value.acceptHostKey(endpoint, fingerprints);
        if (hostKey !== undefined) await core().patchMachine(endpoint, { hostKey });
      },
    };
  });
}, { uses: [InfiniChatProcess] });
