import { hostNamed, method, remote } from '@earendil-works/chord';
import { stringLiteral, stringRecord } from '@earendil-works/pi-ai/providers/schema-builders';
import {
  arr, bool, nul, num, obj, oneOf, opt, str, union, type Schema, type Static,
} from '@earendil-works/pi-schema';

import { ChatMessageSchema } from '../../chat/types';
import { ChatViewSnapshotSchema } from '../chat-view';
import { ScheduledTaskSchema } from '../infinichat-scheduled';
import { InfiniChatControlsSchema } from '../infinichat-view';
import { ScheduledInputSchema } from '../infinichat/schedule';
import { ChatModelSettingsSchema, ModelCatalogSchema } from '../model-catalog';
import { ProviderAccessSchema } from '../provider-credentials';
import { UserInputSchema } from '../user-input';

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
 * The view's snapshot and the Harness's latest report, until it is dismissed. Named `snapshot`: a reference itself
 * has `status`, which Chord reserves.
 */
export const SnapshotSchema = obj({ view: ChatViewSnapshotSchema, report: opt(str()) }, { open: true });
export const ControlsSchema = union([InfiniChatControlsSchema, nul()]);
export const MessagesSchema = readonlyArr(ChatMessageSchema);
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

const FileSchema = obj({ sha256: str(), size: num() }, { open: true });
/** The conversation's database file, its WAL folded into it, by SHA-256 and size. */
export const ConversationFilesSchema = obj({ db: FileSchema }, { open: true });
export type ConversationFiles = Static<typeof ConversationFilesSchema>;
/**
 * Who can hold the conversation: a phone, by the client ID it keeps and the name it gives itself, or a machine another
 * machine hands it to directly, by its endpoint (`machineEndpoint`) and its name.
 */
export const ClientSchema = obj({ id: str(), name: str() }, { open: true });
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
const HostKeySchema = obj({ algorithm: str(), fingerprint: str() }, { open: true });
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
}, { open: true });
export type Machine = Static<typeof MachineSchema>;
/** The conversation's machines document (`machines.ts`), by endpoint; null while the machine doesn't hold it. */
export const MachinesSchema = union([
  obj({ machines: stringRecord(MachineSchema) }, { open: true }), nul(),
]);
/** What a check or an accepted host key changes on a record. */
export const MachinePatchSchema = obj({
  name: opt(str()), publicKey: opt(str()), authorizedKeys: opt(arr(str())), hostKey: opt(HostKeySchema),
}, { open: true });
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
/** pi-ai's `AuthPrompt` without its signal, which stays on the server. */
const AuthPromptSchema = union([
  obj({
    type: oneOf(['text', 'secret', 'manual_code']), message: str(),
    placeholder: opt(str()),
  }, { open: true }),
  obj({
    type: stringLiteral('select'), message: str(),
    options: arr(obj({
      id: str(), label: str(), description: opt(str()),
    }, { open: true })),
  }, { open: true }),
]);
/**
 * The machine's latest sign-in, until the next one starts; null before its first. `status` is the account screen's
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
 * InfiniChat as the machine that runs its Harness serves it: the same view, controls and transcript the phone shows,
 * and the operations of its screens.
 */
export const InfiniChatRemote = remote('infinichat.remote', {
  version: 6,
  input: obj({}, { open: true }),
  host: hostNamed('infinichat-server'),
  variants: {
    owner: {
      state: {
        snapshot: SnapshotSchema, controls: ControlsSchema, messages: MessagesSchema, scheduled: ScheduledSchema,
        server: ServerSchema, conversation: ConversationSchema, catalog: ModelCatalogSchema, access: AccessSchema,
        // Not `signIn`, the method that starts one: Chord refuses a member that is both (`src/contract.ts:232`).
        signInAttempt: SignInAttemptSchema,
        machines: MachinesSchema, reach: ReachSchema, pendingHostKeys: PendingHostKeysSchema,
      },
      methods: {
        accept: method(obj({ content: UserInputSchema, requestId: str() }, { open: true })),
        stop: method(),
        // Continues the run that ended without an answer (`controls.runFailure`): pi-durable's continue submission.
        continue: method(),
        // Loads the entries of the transcript's rows for what isn't loaded (`ChatMessage.history`) into `messages`,
        // which every client reads.
        loadEarlier: method(),
        fillGap: method(obj({ after: num(), upTo: num() }, { open: true })),
        updateSettings: method(obj({
          main: ChatModelSettingsSchema, summary: ChatModelSettingsSchema, instructions: str(),
          name: str(), subagents: opt(union([ChatModelSettingsSchema, nul()])),
        }, { open: true })),
        cancelScheduled: method(obj({ id: num(), replacement: opt(ScheduledInputSchema) }, { open: true }),
          bool()),
        dismissError: method(),
        // The phone's IANA zone, sent on every connect, so the times the agent reads match the phone's clock.
        setTimeZone: method(obj({ zone: str() }, { open: true })),
        // The user's `/reload-plugins`: reloads the tools plugin (code mode and MCP) and the user's plugins with
        // Chord's hot reload, without restarting the server or conversation, and says what it did.
        reloadPlugins: method(undefined, str()),
        // The account screen's operations on the machine's credential store. `signIn` starts an attempt and returns
        // its number; the attempt runs on the server, and its prompts are answered by separate calls.
        signIn: method(obj({ providerId: str() }, { open: true }), num()),
        answer: method(obj({ promptId: num(), value: str() }, { open: true })),
        cancelSignIn: method(),
        setApiKey: method(obj({ providerId: str(), key: str() }, { open: true })),
        signOut: method(obj({ providerId: str() }, { open: true })),
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
        relinquish: method(obj({ to: ClientSchema }, { open: true }), ConversationFilesSchema),
        archive: method(),
        // `pull` brings the database another machine (`from`, as the conversation there lists it, since this one has
        // no conversation open to read it from) released into `data/`, read over this machine's own SSH, once it
        // matches `files`; refused while active, as a phone's upload is. A move between two machines is relinquish
        // there, pull and adopt here, then archive there, with a client orchestrating.
        pull: method(obj({ from: MachineSchema, files: ConversationFilesSchema }, { open: true })),
        // The conversation's machines document, edited through the side that holds it: a record whole, part of one
        // (what a check found, an accepted host key), or its removal. `acceptHostKey` trusts the pending keys with
        // these fingerprints here and records the key on the machine, so the next holder trusts it too.
        putMachine: method(MachineSchema),
        patchMachine: method(obj({ endpoint: str(), patch: MachinePatchSchema }, { open: true })),
        removeMachine: method(obj({ endpoint: str() }, { open: true })),
        acceptHostKey: method(obj({ endpoint: str(), fingerprints: arr(str()) }, { open: true })),
      },
    },
  },
});
