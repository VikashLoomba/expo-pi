import { evolve, hostKind, method, remote, str as paramStr } from '@earendil-works/chord';
import { stringRecord } from '@earendil-works/pi-ai/providers/schema-builders';
import {
  arr, bool, nul, num, obj, opt, str, union, type Schema, type Static,
} from '@earendil-works/pi-schema';

import { ChatControlsProperties, ChatMessageSchema } from '../../chat/types';
import { ChatViewSnapshotSchema } from '../chat-view';
import { AgentInfoSchema } from '../infinichat-agents';
import { ScheduledTaskSchema } from '../infinichat-scheduled';
import { InfiniChatControlsSchema } from '../infinichat-view';
import { ScheduledInputSchema } from '../infinichat/schedule';
import { InfiniChatUsageSchema } from '../infinichat/usage';
import { ChatModelSettingsSchema, ModelCatalogSchema } from '../model-catalog';
import { ProviderAccessSchema } from '../provider-credentials';
import { UserInputSchema } from '../user-input';
import { AuthPromptSchema } from './sign-in-attempt';

/**
 * `{ type: "boolean", const: value }`, shaped as pi-ai's `stringLiteral`: TypeBox's `Literal` JSON, which pi-schema's
 * `lit` writes without `type`, so the contract keeps the fingerprint older apps and servers bind with.
 */
const booleanLiteral = <const V extends boolean>(value: V): Schema<V> => ({ type: 'boolean', const: value });
/** `arr(items)` typed readonly, as TypeBox's `ReadonlyObject` typed it: the views hand out arrays nobody changes. */
const readonlyArr = <T>(items: Schema<T>): Schema<readonly T[]> => arr(items);

/** Who acts on the server: a client, or the server's own code. */
export type InfiniChatPrincipal = { kind: 'owner' } | { kind: 'host' };

/**
 * The machine's server, the one addressable host of its links (chord `docs/design.md` §3 "Host kinds and addresses"):
 * every type clients hold lives there. A client has no address.
 */
export const ServerHost = hostKind('infinichat-server');

/**
 * The view's snapshot and the Harness's latest report, until it is dismissed. Named `snapshot`: a reference itself
 * has `state`, which Chord reserves (chord `docs/design.md` §5, "Reserved member names").
 */
export const SnapshotSchema = obj({ view: ChatViewSnapshotSchema, report: opt(str()) }, { open: true });
/**
 * The controls of versions 8 and 9, from before the tree of agents, kept as they were released: a model for subagents,
 * and no name of the agent a chat is.
 */
const ControlsSchemaV8 = union([obj({
  ...ChatControlsProperties,
  summary: union([ChatModelSettingsSchema, nul()]),
  instructions: str(),
  name: str(),
  subagents: union([ChatModelSettingsSchema, nul()]),
  configured: bool(),
}, { open: true }), nul()]);
export const ControlsSchema = union([InfiniChatControlsSchema, nul()]);
export const MessagesSchema = readonlyArr(ChatMessageSchema);
/** The tree of agents, root first (`AgentList`); null while this machine doesn't hold the conversation open. */
export const AgentsSchema = union([readonlyArr(AgentInfoSchema), nul()]);
/**
 * The scheduled tasks still waiting, soonest first; null while this machine doesn't hold the conversation open or
 * hasn't read them yet, so the phone never takes an empty list it was not given for its notifications.
 */
export const ScheduledSchema = union([readonlyArr(ScheduledTaskSchema), nul()]);
/**
 * Which server answers: its release (`release.ts`). A conversation moves only to a side of the same release or a newer
 * one, because pi-durable's migrations are one-way.
 */
export const ServerSchema = obj({ version: str() }, { open: true });
export type InfiniChatServer = Static<typeof ServerSchema>;

const FileSchema = obj({ sha256: str(), size: num() });
/** The conversation's database file, its WAL folded into it, by SHA-256 and size. */
export const ConversationFilesSchema = obj({ db: FileSchema });
export type ConversationFiles = Static<typeof ConversationFilesSchema>;
/**
 * Who can hold the conversation: a phone, by the client ID it keeps and the name it gives itself, or a machine another
 * machine hands it to directly, by its endpoint (`machineEndpoint`) and its name.
 */
export const ClientSchema = obj({ id: str(), name: str() });
export type InfiniChatClient = Static<typeof ClientSchema>;
/**
 * Whether this machine holds the conversation open, and the files it adopted then. Only the side that holds it opens
 * its database: the server opens it only while `active`, and a phone's home record says whether that phone holds it.
 * `heldBy` is the phone this machine handed it to, from `relinquish` until an `adopt` here, so every client reads
 * where it went.
 */
export const ConversationSchema = obj({ active: bool(),
  adopted: opt(ConversationFilesSchema), heldBy: opt(ClientSchema) }, { open: true });
export type ConversationState = Static<typeof ConversationSchema>;

/** An SSH host key as Remote machines shows it: its algorithm and OpenSSH's `SHA256:` fingerprint. */
const HostKeySchema = obj({ algorithm: str(), fingerprint: str() });
/**
 * A machine of the conversation, which a server's tools reach with its own SSH (pi-env): the name the machine gives
 * itself, its endpoint, the host key a client accepted for it (trust on first use, decided once), its own InfiniChat
 * key and the machines' keys authorized there by the key exchange (`keys.ts`), as `authorized_keys` matches them: a
 * change is worth another check. Never its credentials, which each client keeps for itself.
 */
export const MachineSchema = obj({
  name: str(), hostname: str(), port: num(), username: str(),
  hostKey: opt(HostKeySchema), publicKey: opt(str()),
  authorizedKeys: opt(arr(str())),
});
export type Machine = Static<typeof MachineSchema>;
/** The conversation's machines document (`machines.ts`), by endpoint; null while the machine doesn't hold it. */
export const MachinesSchema = union([
  obj({ machines: stringRecord(MachineSchema) }, { open: true }), nul(),
]);
/** What a check or an accepted host key changes on a record. */
export const MachinePatchSchema = obj({
  name: opt(str()), publicKey: opt(str()), authorizedKeys: opt(arr(str())), hostKey: opt(HostKeySchema),
});
/** What the server knows a machine by, whichever client lists it: `username@hostname:port`. */
export const machineEndpoint = ({ username, hostname, port }: { username: string; hostname: string; port: number }) =>
  `${username}@${hostname}:${port}`;
/**
 * The parts of an endpoint, for a client that must reach the machine before it can read the document that lists
 * it, such as the one holding the conversation; undefined for a string that is not an endpoint.
 */
export function endpointMachine(endpoint: string): Pick<Machine, 'hostname' | 'port' | 'username'> | undefined {
  const at = endpoint.indexOf('@');
  const colon = endpoint.lastIndexOf(':');
  if (at < 1 || colon < at + 2 || colon === endpoint.length - 1) return undefined;
  const port = Number(endpoint.slice(colon + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { username: endpoint.slice(0, at), hostname: endpoint.slice(at + 1, colon), port };
}
/** Per machine endpoint, whether the server reached it the last time it tried, and pi-env's error when it didn't. */
export const ReachSchema = stringRecord(union([
  obj({ reachable: booleanLiteral(true) }, { open: true }),
  obj({ reachable: booleanLiteral(false), error: str() }, { open: true }),
]));
export type Reach = Static<typeof ReachSchema>;
/**
 * Per machine endpoint, the host keys the server's scan found that it doesn't trust, which only a client can accept;
 * `changed` when they replace a key it trusted.
 */
export const PendingHostKeysSchema = stringRecord(
  obj({ keys: arr(HostKeySchema), changed: bool() }, { open: true }));
export type PendingHostKeys = Static<typeof PendingHostKeysSchema>;

/** The provider sign-ins of the machine's own credential store, keyed by provider. */
export const AccessSchema = stringRecord(ProviderAccessSchema);
/**
 * The machine's latest provider sign-in (`sign-in-attempt.ts`, its fields in their first order, which the contract's
 * fingerprint keeps), until the next one starts; null before its first. `status` is the account screen's
 * public copy, absent once an attempt succeeded, as that screen clears its notice. While it runs, `url` is pi-ai's
 * `auth_url`, and `prompt` waits for `answer` with its `id`. An attempt that ended stays, so a phone that learns its
 * attempt's number before its state still finds how it ended.
 */
export const SignInAttemptSchema = union([nul(), obj({
  attempt: num(),
  providerId: str(),
  running: bool(),
  status: opt(str()),
  url: opt(str()),
  prompt: opt(obj({ id: num(), prompt: AuthPromptSchema }, { open: true })),
}, { open: true })]);
export type SignInAttempt = Static<typeof SignInAttemptSchema>;

/**
 * What the machine's InfiniChat offered at version 8 of its contract, which server 4.1.0 released: the base of the
 * contract's history (chord `docs/design.md` §27), written in full and left as it is. An app built with a version
 * binds by that version's fingerprint, which Chord computes from these schemas, so a change here, or to a schema
 * this names, locks out every app on it. A change is an edit of the next version instead (`InfiniChatRemote`).
 */
const InfiniChatMembersV8 = {
  state: {
    snapshot: SnapshotSchema, controls: ControlsSchemaV8, messages: MessagesSchema, scheduled: ScheduledSchema,
    server: ServerSchema, conversation: ConversationSchema, catalog: ModelCatalogSchema, access: AccessSchema,
    // Not `signIn`, the method that starts one: a member name is state or a method, never both (design §5).
    signInAttempt: SignInAttemptSchema,
    machines: MachinesSchema, reach: ReachSchema, pendingHostKeys: PendingHostKeysSchema,
  },
  methods: {
    accept: method(obj({ content: UserInputSchema, requestId: str() })),
    stop: method(),
    // Continues the run that ended without an answer (`controls.runFailure`): pi-durable's continue submission.
    continue: method(),
    // Loads the entries of the transcript's rows for what isn't loaded (`ChatMessage.history`) into `messages`,
    // which every client reads.
    loadEarlier: method(),
    fillGap: method(obj({ after: num(), upTo: num() })),
    updateSettings: method(obj({
      main: ChatModelSettingsSchema, summary: ChatModelSettingsSchema, instructions: str(),
      name: str(), subagents: opt(union([ChatModelSettingsSchema, nul()])),
    })),
    cancelScheduled: method(obj({ id: num(), replacement: opt(ScheduledInputSchema) }),
      bool()),
    dismissError: method(),
    // What the conversation has spent, by model, and what writing its memory has; read when a screen asks.
    usage: method(undefined, InfiniChatUsageSchema),
    // The phone's IANA zone, sent on every connect, so the times the agent reads match the phone's clock.
    setTimeZone: method(obj({ zone: str() })),
    // The user's `/reload-plugins`: reloads the tools plugin (code mode and MCP) and the user's plugins with
    // Chord's hot reload, without restarting the server or conversation, and says what it did.
    reloadPlugins: method(undefined, str()),
    // The account screen's operations on the machine's credential store. `signIn` starts an attempt and returns
    // its number; the attempt runs on the server, and its prompts are answered by separate calls.
    signIn: method(obj({ providerId: str() }), num()),
    answer: method(obj({ promptId: num(), value: str() })),
    cancelSignIn: method(),
    setApiKey: method(obj({ providerId: str(), key: str() })),
    signOut: method(obj({ providerId: str() })),
    // Fetches pi.dev's newer models for the machine's providers into `catalog` (`chat-providers.ts`); it rejects
    // when a provider's fetch failed, and that provider keeps the models it had.
    refreshCatalog: method(),
    // Moving the conversation, as upstream's session sync hands a session over: one side closes its Harness, the
    // files are copied, the other side opens them. `adopt` opens the files in `data/` when they match, and is
    // refused while active; it clears `heldBy`. `relinquish` (Chord reserves `release`) records the phone it
    // hands the conversation `to` as `heldBy`, stops input, closes the Harness and its storage, and names the files
    // it left; called again with the same phone, it names them again, and with another it is refused, so one
    // handover runs at a time. `archive` keeps the released database as the machine's copy, which nothing opens,
    // and `heldBy` with it; it is refused while active.
    adopt: method(ConversationFilesSchema),
    // Starts a conversation of this machine's own, for a person whose InfiniChat is on no device yet; refused while
    // this machine holds one, has handed one to a phone, or keeps a database a move left.
    create: method(),
    relinquish: method(obj({ to: ClientSchema }), ConversationFilesSchema),
    archive: method(),
    // `pull` brings the database another machine (`from`, as the conversation there lists it, since this one has
    // no conversation open to read it from) released into `data/`, read over this machine's own SSH, once it
    // matches `files`; refused while active, as a phone's upload is. A move between two machines is relinquish
    // there, pull and adopt here, then archive there, with a client orchestrating.
    pull: method(obj({ from: MachineSchema, files: ConversationFilesSchema })),
    // The conversation's machines document, edited through the side that holds it: a record whole, part of one
    // (what a check found, an accepted host key), or its removal. `acceptHostKey` trusts the pending keys with
    // these fingerprints here and records the key on the machine, so the next holder trusts it too.
    putMachine: method(MachineSchema),
    patchMachine: method(obj({ endpoint: str(), patch: MachinePatchSchema })),
    removeMachine: method(obj({ endpoint: str() })),
    acceptHostKey: method(obj({ endpoint: str(), fingerprints: arr(str()) })),
  },
};

/**
 * `setApiKey`'s arguments since version 9. `workspaceId` is Anthropic's: the workspace a key that isn't scoped to
 * one acts in, saved with the key (`sign-in.ts`). It is a field of its own because a method's arguments are closed
 * (design §5, "Arguments"), which the map a credential keeps it in is not.
 */
const ApiKeySchema = obj({ providerId: str(), key: str(), workspaceId: opt(str()) });

/**
 * `updateSettings`' arguments since version 10: root's model, and what the whole tree shares. Each other agent's
 * model is its own (`InfiniChatAgent`).
 */
const SettingsSchema = obj({
  main: ChatModelSettingsSchema, summary: ChatModelSettingsSchema, instructions: str(), name: str(),
});

/**
 * What the machine's InfiniChat offers now, declared once: the server's store object holds these members for the
 * host's life, and the type clients hold re-exposes them (chord `docs/design.md` §6, "shared store, per-principal
 * views"). Version 8's, with each later version's edits.
 */
export const InfiniChatMembers = {
  state: { ...InfiniChatMembersV8.state, controls: ControlsSchema, agents: AgentsSchema },
  methods: {
    ...InfiniChatMembersV8.methods, setApiKey: method(ApiKeySchema), updateSettings: method(SettingsSchema),
  },
};

const InfiniChatRemoteV8 = remote('infinichat.remote', {
  version: 8,
  params: {},
  hostAddress: () => ServerHost(),
  variants: { owner: InfiniChatMembersV8 },
});

/**
 * InfiniChat as the machine that runs its Harness serves it: the same view, controls and transcript the phone shows,
 * and the operations of its screens.
 *
 * Each version is Chord's `evolve` of the one before (design §27, "Contract evolution in code"), and the server maps
 * the versions it still serves to the newest where it serves the type (`accepts`, `infinichat-server/src/facet.ts`),
 * so an app keeps working with every server released after it. An app newer than the server is the one case Chord
 * leaves waiting: it asks that server to update itself (`client.ts`).
 *
 * - 9: `setApiKey` takes a workspace ID.
 * - 10: the tree of agents. `agents` lists it; `controls` name the agent a chat is and keep no model for subagents,
 *   and `updateSettings` takes none. The view, `accept`, `stop` and `continue` are root's, as they were the one
 *   chat's; every agent's chat is an `InfiniChatAgent`.
 */
const InfiniChatRemoteV9 = evolve(InfiniChatRemoteV8, (edit) => edit.args('setApiKey', ApiKeySchema));
export const InfiniChatRemote = evolve(InfiniChatRemoteV9, (edit) => edit
  .state('owner', 'controls', ControlsSchema)
  .args('updateSettings', SettingsSchema)
  .addState('owner', 'agents', AgentsSchema));

/** An agent's chat as its object serves it: the view's own snapshot, with no report, which is the conversation's. */
export const InfiniChatAgentMembers = {
  state: { snapshot: ChatViewSnapshotSchema, controls: ControlsSchema, messages: MessagesSchema },
  methods: {
    loadEarlier: method(),
    fillGap: method(obj({ after: num(), upTo: num() })),
    // That agent's turn, and its run that ended without an answer.
    stop: method(),
    continue: method(),
    // The model and effort it runs on from its next request.
    setModel: method(ChatModelSettingsSchema),
  },
};

/**
 * One agent of the tree as the machine serves it, by its name there, root too: its chat as the phone shows any
 * chat, which the user reads while its screen is open, and what the user does to it, as UniiChat's views show any
 * unii and stop it or pick its model. The user's messages go to root alone (`InfiniChatRemote.accept`). An object
 * lives while a client holds it (chord `docs/design.md` §6, "Lifetime follows from kind and params"), so only the
 * chats on screen are followed. A name the tree does not have shows as a missing view.
 */
export const InfiniChatAgent = remote('infinichat.agent', {
  version: 1,
  params: { name: paramStr() },
  hostAddress: () => ServerHost(),
  variants: { owner: InfiniChatAgentMembers },
});
