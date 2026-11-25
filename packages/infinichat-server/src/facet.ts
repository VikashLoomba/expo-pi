import { join } from 'node:path';

import { constant, defineFacet, local, untilAborted, type AcceptsTable, type Ctx } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import type { Models } from '@earendil-works/pi-ai';
import { registryReader } from '@earendil-works/pi-durable';
import { createFitImagesExtension } from '@earendil-works/pi-durable/images/fit';
import type { Static } from '@earendil-works/pi-schema';
import { fileCredentialBackend, openAILoginOptions } from '@pi-agent/infinichat/node/credentials';
import { serverDevices, serverImages } from '@pi-agent/infinichat/node/devices';
import { ServerMachines } from '@pi-agent/infinichat/node/machines';
import { createServerModels } from '@pi-agent/infinichat/node/models';
import type { ChatViewSnapshot, ChatViewSource } from '@pi-agent/infinichat/pi/chat-view';
import {
  InfiniChatAgent, InfiniChatMembers, InfiniChatRemote, type AccessSchema, type ActiveSecretsSchema,
  type AgentsSchema, type ControlsSchema, type ConversationState, type InfiniChatPrincipal, type MachinesSchema,
  type MessagesSchema, type PendingHostKeys, type PendingQuestionsSchema, type ReachSchema, type ScheduledSchema,
  type SignInAttempt, type SnapshotSchema,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { CLAUDE_CODE_PROVIDER_ID } from '@pi-agent/infinichat/pi/claude-code';
import {
  InfiniChatService, infiniChatExtensions, type InfiniChatSettings,
} from '@pi-agent/infinichat/pi/infinichat-service';
import type { InfiniChatControls } from '@pi-agent/infinichat/pi/infinichat-view';
import { buildModelCatalog, type ModelCatalog } from '@pi-agent/infinichat/pi/model-catalog';
import { validateOpenAICredential } from '@pi-agent/infinichat/pi/openai-auth/core';
import {
  ProviderCredentialStore, type CredentialBackend, type ProviderAccess,
} from '@pi-agent/infinichat/pi/provider-credentials';
import { ProviderSignIn } from '@pi-agent/infinichat/pi/sign-in';

import { claudeCodeAccess, closeClaudeCode, registerClaudeCode } from './claude-code';
import { ServerConversation } from './conversation';
import { extending } from './extending';
import { done, type ServerProcess } from './process';
import { composeExtensions, Extensions } from './registry';
import { setTimeZone } from './state';

/** The credential store, its backend, and the models over it, which the Harness and the sign-in share. */
interface Account { backend: CredentialBackend; credentials: ProviderCredentialStore; models: Models }

/** What the open conversation shows, published together so a client never sees one part without the others. */
interface ConversationView {
  snapshot: Static<typeof SnapshotSchema>;
  controls: Static<typeof ControlsSchema>;
  messages: Static<typeof MessagesSchema>;
  scheduled: Static<typeof ScheduledSchema>;
  pendingQuestions: Static<typeof PendingQuestionsSchema>;
  activeSecrets: Static<typeof ActiveSecretsSchema>;
  machines: Static<typeof MachinesSchema>;
  agents: Static<typeof AgentsSchema>;
  conversation: ConversationState;
}
/** What one agent's chat shows, published together as the conversation's is. */
interface AgentView {
  snapshot: ChatViewSnapshot;
  controls: Static<typeof ControlsSchema>;
  messages: Static<typeof MessagesSchema>;
}
interface AccountView { catalog: ModelCatalog; access: Static<typeof AccessSchema>; signInAttempt: SignInAttempt }
interface ReachView { reach: Static<typeof ReachSchema>; pendingHostKeys: PendingHostKeys }

const LOADING = { status: 'loading' } as const;
/** What the members read from the object's activation until its first routine has read the natives. */
const NO_VIEW: ConversationView = { snapshot: { view: LOADING }, controls: null, messages: [], scheduled: null,
  pendingQuestions: null, activeSecrets: [], machines: null, agents: null, conversation: { active: false } };
const NO_AGENT_VIEW: AgentView = { snapshot: LOADING, controls: null, messages: [] };
const NO_ACCOUNT: AccountView = { catalog: [], access: {}, signInAttempt: null };
const NO_REACH: ReachView = { reach: {}, pendingHostKeys: {} };

/**
 * InfiniChat on this machine, one object for the host's life, as pi-durable's `test/examples/37-harness-registry.ts`
 * gives a host its Durable Harness: what outlives every client. It owns the natives (the credential store and its
 * sign-in, the other machines' connections, the conversation's holder) and the members clients read, which
 * `InfiniChatRemote` re-exposes (chord `docs/design.md` §6, "shared store, per-principal views"). Only a release
 * changes this plugin, and a release restarts the process (`update.ts`). The Harness reads its extensions from
 * `Extensions`: InfiniChat's own and `extending`'s, contributed by this facet, the tools plugin's and installed
 * plugins'. It opens the database only while this machine holds the conversation (`ServerConversation`), so the
 * object holds the holder rather than the Harness itself. Its version follows its members, as Chord has every
 * contract change bump it; this plugin is its only consumer, so it accepts no older one.
 */
export const InfiniChatMachine = local('infinichat.machine', {
  version: 3,
  params: {},
  members: { ...InfiniChatMembers.state, ...InfiniChatMembers.methods },
});

/** A call's context for the core's own waits: the caller cancels the wait, never the work. */
const callContext = (ctx: Ctx<InfiniChatPrincipal>) =>
  ctx.abortSignal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(ctx.abortSignal, BACKGROUND_CONTEXT);

/** This plugin's release, which the runtime it runs on reads here, holding none of its own (`main.ts`). */
export const version = INFINICHAT_SERVER_VERSION;

/**
 * A move as an app on versions 8 to 10 asks for it, which copies the database file: refused, by a call of the
 * server's own in place of each of its methods (design §27, "a removed or changed method served by the provider's own
 * function"), so the app shows why instead of a contract error. `relinquish` is refused before it closes anything, so
 * the conversation stays open here; an app whose move this stops puts it back with its Cancel.
 */
const refuseMove = { call: async (): Promise<never> => {
  throw new Error('Update this app to move InfiniChat: this machine’s server moves the conversation in a newer way.');
} };
const MOVE_NEEDS_THE_APP_UPDATED = { adopt: refuseMove, relinquish: refuseMove, pull: refuseMove, archive: refuseMove };

/**
 * The versions of `infinichat.remote` this server still serves besides the newest, each with what its later edits
 * need mapped (chord `docs/design.md` §27, "Mappings live with the provider"), so the apps released with them keep
 * working with this server. A version is dropped only once no app on it is in use.
 *
 * - 10: its move copies the database file, where a move is Chord's session sync now, so each method of its move is
 *   refused with a message that says to update the app; chatting needs none of them. Its `conversation` has no
 *   `head`, which only a move reads.
 * - 9: 10's, and its controls keep a model for subagents, which the tree's agents have none of, and no name of the
 *   agent a chat is; its `updateSettings` sends that model, which is dropped. It shows root's chat as the one chat,
 *   and no tree.
 * - 8: 9's, and its `setApiKey` arguments are the newest's without a workspace ID.
 */
const ACCEPTED: AcceptsTable<typeof InfiniChatRemote> = {
  11: {},
  10: {
    state: { owner: { conversation: (current) => beforeSync(current) } },
    methods: { ...MOVE_NEEDS_THE_APP_UPDATED },
  },
  9: {
    state: { owner: { controls: (current) => beforeTree(current), conversation: (current) => beforeSync(current) } },
    methods: { updateSettings: { args: (old) => withoutSubagents(old) }, ...MOVE_NEEDS_THE_APP_UPDATED },
  },
  8: {
    state: { owner: { controls: (current) => beforeTree(current), conversation: (current) => beforeSync(current) } },
    methods: { setApiKey: { args: (old) => old }, updateSettings: { args: (old) => withoutSubagents(old) },
      ...MOVE_NEEDS_THE_APP_UPDATED },
  },
};

/** The machine's conversation as versions 8 to 10 read it. */
const beforeSync = ({ active, heldBy }: ConversationState) => ({ active, ...(heldBy === undefined ? {} : { heldBy }) });

/** The controls as versions 8 and 9 have them. */
function beforeTree(current: Static<typeof ControlsSchema>) {
  if (current === null) return null;
  const { agent: _root, ...controls } = current;
  return { ...controls, subagents: null };
}

/** The settings versions 8 and 9 send, as the newest takes them. */
const withoutSubagents = ({ main, summary, instructions, name }: InfiniChatSettings): InfiniChatSettings =>
  ({ main, summary, instructions, name });

/**
 * InfiniChat's server plugin: the facet a server host loads from its runtime (`main.ts`), given the process as start
 * data (design §18), and replaces on update.
 */
export default (proc: ServerProcess) => defineFacet<InfiniChatPrincipal>((host, facet) => {
  // The store object's natives as InfiniChat's own extensions reach them: Durable calls a tool with its own context
  // and no Chord `ctx` (design §24), and only while the conversation is open, which is while both are set.
  let machinesOpen: ServerMachines | undefined;
  let conversationOpen: ServerConversation | undefined;
  const report = (error: unknown) => {
    const current = conversationOpen?.current;
    if (current) current.report(error);
    else console.error('InfiniChat:', error instanceof Error ? error.message : error);
  };
  // This machine, holding the chat, then the other machines: the device tools' devices and the conversation's
  // environment.
  const images = serverImages();
  const devices = serverDevices(() => ({ name: proc.device, description: proc.description }), () => {
    if (machinesOpen === undefined) throw new Error('This machine’s connections are not open yet.');
    return machinesOpen;
  }, images, proc.secrets);
  const parts = infiniChatExtensions(devices, () => conversationOpen?.current?.harness, report, proc.secrets);
  // From the facet, so the table holds them before the Harness opens (a task whose definition is missing stays
  // blocked, design §24). With them, what only a machine's agents have: how they extend this server, and pi-durable's
  // own fitting of the images a call's result holds to the agent's model, before the result is stored (durable
  // `test/examples/47-fit-images.ts`). A machine's images come from MCP tools and from scripts (`image()`), which no
  // tool of InfiniChat's fits, as `read` fits its own.
  facet.contribute(Extensions, [...parts.extensions, createFitImagesExtension(images), extending(proc)]);
  host.serve(Extensions, { compose: composeExtensions });

  host.serve(InfiniChatMachine, (_params, self) => {
    const { home, device } = proc;
    // A declared dependency: the object activates, and opens Durable, once the registry has a value.
    const extensions = self.registry(Extensions);
    const account = self.open<Account>(async () => {
      // pi-ai's own persistence seam: this machine's store; its file outlives the process.
      const backend = fileCredentialBackend(join(home, 'credentials.json'));
      const credentials = new ProviderCredentialStore(backend, { openai: { validate: validateOpenAICredential } },
        `Check that ~/.infinichat/credentials.json on ${device} can be read and written, then try again.`);
      const models = createServerModels(credentials);
      registerClaudeCode(models);
      credentials.registerProviders(models.getProviders().map((provider) => provider.id));
      // A provider whose credential cannot be read reports it in its own access state.
      await credentials.restore().catch(() => {});
      // pi.dev's newer models before the Harness opens, so work it resumes finds a model pi-ai doesn't ship
      // (`chat-providers.ts`); each fetch waits at most pi's own 4 s, and a failed one keeps pi-ai's.
      await models.refresh();
      return { backend, credentials, models };
    }, closeClaudeCode);
    const signIn = self.open(async () => new ProviderSignIn(account.value.models, account.value.credentials,
      openAILoginOptions(account.value.backend)),
    // Ends an attempt still under way.
    (attempts) => attempts.cancel());
    // The other machines' connections, which the conversation's tools use; they close after it.
    const machines = self.open(async () => {
      machinesOpen = new ServerMachines(home, device);
      return machinesOpen;
    }, (connections) => {
      machinesOpen = undefined;
      return connections.close();
    });
    const conversation = self.open(async (context) => {
      // One reader for every hold of the conversation; its observations end with this attempt's context.
      const registry = registryReader(extensions, context);
      const held = new ServerConversation(home, (storage) => InfiniChatService.open({
        storage, models: account.value.models, parts, registry, machine: device, env: devices.env,
        secrets: proc.secrets,
        accountChanges: account.value.credentials.subscribe,
        onClosed: (end) => {
          if (end.kind === 'failed') proc.fail(end.error);
        },
      }), proc.loaded);
      await held.start();
      conversationOpen = held;
      return held;
    // Closing waits for running task code; work it cuts off stays pending for the next open.
    }, async (held) => {
      await held.close();
      conversationOpen = undefined;
    });
    // The machines are the open conversation's document; the connections follow it and outlive each hold.
    self.open(async () => machines.value.follow({
      subscribe: conversation.value.subscribe,
      current: () => conversation.value.current?.machines.getSnapshot(),
    }), (unfollow) => unfollow());

    const core = () => {
      const open = conversation.value.current;
      if (!open) throw new Error(`InfiniChat isn’t open on ${device}.`);
      return open;
    };
    const viewNow = (): ConversationView => {
      const open = conversation.value.current;
      const error = open?.getSnapshot().error;
      return {
        snapshot: open ? { view: open.view().getSnapshot(), ...(error === undefined ? {} : { report: error }) }
          : NO_VIEW.snapshot,
        controls: open?.view().getControls() ?? null,
        messages: open?.view().getMessages() ?? NO_VIEW.messages,
        scheduled: open?.scheduled.getSnapshot() ?? null,
        pendingQuestions: open?.questions.getSnapshot() ?? null,
        activeSecrets: proc.secrets.getSnapshot(),
        machines: open?.machines.getSnapshot() ?? null,
        agents: open?.agents.getSnapshot() ?? null,
        conversation: conversation.value.getState(),
      };
    };
    // The natives' own stores, mirrored into in-process values an `onLive` routine keeps current (design §14, "set
    // up, wait for the end, clean up"); each member is a derive over one, so its changes go out as a diff. The
    // conversation's seven members share one value: a derive is recomputed in the flush of the change that marked it,
    // so they travel in one message, and a client's first `ready` never arrives before its messages.
    const view = self.writable(NO_VIEW);
    const accountView = self.writable(NO_ACCOUNT);
    const reachView = self.writable(NO_REACH);
    // Claude Code keeps its own login, so its access comes from asking it, not from the credential store.
    let claudeCode: ProviderAccess = { ready: false, connected: false };
    const publishAccount = () => accountView.set({ ...accountView.value,
      access: { ...account.value.credentials.getSnapshot().providers, [CLAUDE_CODE_PROVIDER_ID]: claudeCode },
      signInAttempt: signIn.value.getSnapshot() });
    const readClaudeCode = async () => {
      claudeCode = await claudeCodeAccess(account.value.models);
      publishAccount();
      // Its login is no change of the credential store, so the conversation hears of it here.
      const open = conversation.value.current;
      if (claudeCode.connected) void open?.chooseDefaults().catch((error: unknown) => open.report(error));
    };
    self.onLive(async (ctx) => {
      const publishView = () => view.set(viewNow());
      const publishReach = () => reachView.set({ reach: machines.value.getReach(),
        pendingHostKeys: machines.value.getPending() });
      accountView.set({ ...accountView.value, catalog: buildModelCatalog(account.value.models) });
      publishView();
      publishAccount();
      publishReach();
      void readClaudeCode();
      const stops = [conversation.value.subscribe(publishView), proc.secrets.subscribe(publishView),
        account.value.credentials.subscribe(publishAccount), signIn.value.subscribe(publishAccount),
        machines.value.subscribe(publishReach)];
      try {
        await untilAborted(ctx);
      } finally {
        for (const stop of stops) stop();
      }
    });

    return {
      snapshot: self.derive([view], ([shown]) => shown.snapshot),
      controls: self.derive([view], ([shown]) => shown.controls),
      // Chord's JSON arrays are mutable types; the copies keep their elements, which the diff compares by identity.
      messages: self.derive([view], ([shown]) => [...shown.messages]),
      scheduled: self.derive([view], ([shown]) => shown.scheduled && [...shown.scheduled]),
      pendingQuestions: self.derive([view], ([shown]) => shown.pendingQuestions && [...shown.pendingQuestions]),
      activeSecrets: self.derive([view], ([shown]) => [...shown.activeSecrets]),
      machines: self.derive([view], ([shown]) => shown.machines),
      agents: self.derive([view], ([shown]) => shown.agents && [...shown.agents]),
      conversation: self.derive([view], ([shown]) => shown.conversation),
      // This code's release.
      server: constant({ version }),
      catalog: self.derive([accountView], ([shown]) => shown.catalog),
      access: self.derive([accountView], ([shown]) => shown.access),
      signInAttempt: self.derive([accountView], ([shown]) => shown.signInAttempt),
      reach: self.derive([reachView], ([shown]) => shown.reach),
      pendingHostKeys: self.derive([reachView], ([shown]) => shown.pendingHostKeys),
      accept: async ({ content, requestId }, ctx) => done(core().accept(content, requestId, callContext(ctx))),
      stop: async () => done(core().stop()),
      continue: async () => done(core().continue()),
      loadEarlier: async () => done(core().view().loadEarlier()),
      fillGap: async (gap) => done(core().view().fillGap(gap)),
      updateSettings: async (settings, ctx) => done(core().updateSettings(settings, callContext(ctx))),
      cancelScheduled: async ({ id, replacement }, ctx) =>
        core().cancelScheduled(id, replacement, callContext(ctx)),
      answerQuestions: async ({ taskId, answers }, ctx) =>
        done(core().answerQuestions(taskId, answers, callContext(ctx))),
      clearSecrets: async ({ id }) => done(proc.secrets.clear(id)),
      dismissError: async () => done(core().dismissError()),
      // Chord's JSON arrays are mutable types.
      usage: async () => [...await core().usage()],
      setTimeZone: async ({ zone }) => done(setTimeZone(home, zone)),
      reloadPlugins: () => proc.reloadPlugins(),
      signIn: async ({ providerId }) => signIn.value.signIn(providerId),
      answer: async ({ promptId, value }) => done(signIn.value.answer(promptId, value)),
      cancelSignIn: async () => done(signIn.value.cancel()),
      setApiKey: async ({ providerId, key, workspaceId }) =>
        done(signIn.value.setApiKey(providerId, key, workspaceId)),
      signOut: async ({ providerId }) => done(signIn.value.signOut(providerId)),
      refreshCatalog: async () => {
        const models = account.value.models;
        const result = await models.refresh();
        accountView.set({ ...accountView.value, catalog: buildModelCatalog(models) });
        // A sign-in at the machine's terminal since the last look shows now.
        await readClaudeCode();
        // Without a Claude Code login there are no models of its to refresh, which is no failure of the refresh.
        const failed = [...result.errors.keys()]
          .filter((providerId) => providerId !== CLAUDE_CODE_PROVIDER_ID || claudeCode.connected);
        if (failed.length) {
          throw new Error('Some provider models could not be refreshed. Existing models are still available.');
        }
        return null;
      },
      // The move goes on when the caller goes away: a dropped link never leaves it half done.
      adopt: async ({ head }) => done(conversation.value.adopt(head)),
      create: async () => done(conversation.value.create()),
      relinquish: async ({ to }) => {
        // Wipe ephemeral RAM secrets whenever the conversation leaves this machine.
        proc.secrets.clear();
        return conversation.value.relinquish(to, (endpoint) => machines.value.environmentAt(endpoint));
      },
      pull: async ({ from, head }, ctx) => done(conversation.value.pull(
        from === undefined ? undefined : await machines.value.environment(from), head, callContext(ctx))),
      putMachine: async (record) => done(core().putMachine(record)),
      patchMachine: async ({ endpoint, patch }) => done(core().patchMachine(endpoint, patch)),
      removeMachine: async ({ endpoint }) => done(core().removeMachine(endpoint)),
      acceptHostKey: async ({ endpoint, fingerprints }) => {
        const hostKey = await machines.value.acceptHostKey(endpoint, fingerprints);
        if (hostKey !== undefined) await core().patchMachine(endpoint, { hostKey });
        return null;
      },
    };
  });

  /**
   * InfiniChat as clients hold it (all act as the owner): the store object's members, re-exposed. While this machine
   * doesn't hold the conversation, there is no core: the view is loading, the scheduled tasks are null and the
   * operations refuse. `conversation` says whether it holds it, or which phone it went to, and `relinquish`, `pull`
   * and `adopt` move it. `server` says which release answers, and `setTimeZone` applies the phone's zone. The
   * account members mirror this machine's credential store and its sign-in; `catalog` is the machine's models, as
   * fetched from pi.dev at start and again on `refreshCatalog`. `reach` and `pendingHostKeys` mirror what this machine
   * found of the other machines its tools use, which any client trusts with `acceptHostKey`.
   */
  host.serve(InfiniChatRemote, (_params, _principal, self) => {
    const machine = self.get(InfiniChatMachine, {});
    return {
      variant: 'owner',
      members: {
        snapshot: machine.snapshot, controls: machine.controls, messages: machine.messages,
        scheduled: machine.scheduled, pendingQuestions: machine.pendingQuestions, activeSecrets: machine.activeSecrets,
        machines: machine.machines, agents: machine.agents,
        conversation: machine.conversation,
        server: machine.server, catalog: machine.catalog, access: machine.access,
        signInAttempt: machine.signInAttempt, reach: machine.reach, pendingHostKeys: machine.pendingHostKeys,
        accept: machine.accept, stop: machine.stop, continue: machine.continue, loadEarlier: machine.loadEarlier,
        fillGap: machine.fillGap, updateSettings: machine.updateSettings, cancelScheduled: machine.cancelScheduled,
        answerQuestions: machine.answerQuestions, clearSecrets: machine.clearSecrets,
        usage: machine.usage, create: machine.create,
        dismissError: machine.dismissError, setTimeZone: machine.setTimeZone, reloadPlugins: machine.reloadPlugins,
        signIn: machine.signIn, answer: machine.answer, cancelSignIn: machine.cancelSignIn,
        setApiKey: machine.setApiKey, signOut: machine.signOut, refreshCatalog: machine.refreshCatalog,
        adopt: machine.adopt, relinquish: machine.relinquish, pull: machine.pull,
        putMachine: machine.putMachine, patchMachine: machine.patchMachine, removeMachine: machine.removeMachine,
        acceptHostKey: machine.acceptHostKey,
      },
    };
  }, { accepts: ACCEPTED });

  /**
   * One agent's chat, by its name in the tree, while a client holds it: the open core's view of that agent, which it
   * follows from the core's own stores as the store object follows the conversation's, and that agent's operations.
   * It waits for the store object, which holds the conversation's holder. While this machine doesn't hold the
   * conversation, the view is loading and the operations refuse; a name the tree does not have shows as missing.
   */
  host.serve(InfiniChatAgent, ({ name }, _principal, self) => {
    self.get(InfiniChatMachine, {});
    const chat = () => {
      const open = conversationOpen?.current;
      if (!open) throw new Error(`InfiniChat isn’t open on ${proc.device}.`);
      return open.agent(name);
    };
    const shown = self.writable(NO_AGENT_VIEW);
    self.onLive(async (ctx) => {
      const held = conversationOpen;
      // The view of the core open now; the core comes and goes with a move, and its tree is read after it opens.
      let followed: ChatViewSource<InfiniChatControls> | undefined;
      let unfollow = () => {};
      const publish = () => {
        const view = held?.current?.agent(name).view();
        if (view !== followed) {
          const previous = unfollow;
          followed = view;
          unfollow = view?.subscribe(publish) ?? (() => {});
          previous();
        }
        const next: AgentView = view === undefined ? NO_AGENT_VIEW
          : { snapshot: view.getSnapshot(), controls: view.getControls() ?? null, messages: view.getMessages() };
        const last = shown.value;
        // The holder tells of every change of the conversation; this agent's chat is published only when it changed.
        if (next.snapshot !== last.snapshot || next.controls !== last.controls || next.messages !== last.messages) {
          shown.set(next);
        }
      };
      const stop = held?.subscribe(publish);
      publish();
      try {
        await untilAborted(ctx);
      } finally {
        stop?.();
        unfollow();
      }
    });
    return {
      variant: 'owner',
      members: {
        snapshot: self.derive([shown], ([view]) => view.snapshot),
        controls: self.derive([shown], ([view]) => view.controls),
        // Chord's JSON arrays are mutable types; the copy keeps its elements, which the diff compares by identity.
        messages: self.derive([shown], ([view]) => [...view.messages]),
        loadEarlier: async () => done(chat().view().loadEarlier()),
        fillGap: async (gap) => done(chat().view().fillGap(gap)),
        stop: async () => done(chat().stop()),
        continue: async () => done(chat().continue()),
        setModel: async (settings) => done(chat().setModel(settings)),
      },
    };
  });
});
