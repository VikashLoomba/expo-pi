import { hostNamed, method, remote } from '@earendil-works/chord';
import { Type, type Static } from '@earendil-works/pi-ai';

import { ChatMessageSchema } from '../../chat/types';
import { ChatViewSnapshotSchema } from '../chat-view';
import { ScheduledTaskSchema } from '../infinichat-scheduled';
import { InfiniChatControlsSchema } from '../infinichat-view';
import { ScheduledInputSchema } from '../infinichat/schedule';
import { ChatModelSettingsSchema, ModelCatalogSchema } from '../model-catalog';
import { ProviderAccessSchema } from '../provider-credentials';
import { UserInputSchema } from '../user-input';

/** Who acts on the server: a client, or the server's own code. */
export type InfiniChatPrincipal = { kind: 'owner' } | { kind: 'host' };

/**
 * The view's snapshot and the Harness's latest report, until it is dismissed. Named `snapshot`: a reference itself
 * has `status`, which Chord reserves.
 */
export const SnapshotSchema = Type.Object({ view: ChatViewSnapshotSchema, report: Type.Optional(Type.String()) });
export const ControlsSchema = Type.Union([InfiniChatControlsSchema, Type.Null()]);
export const MessagesSchema = Type.ReadonlyObject(Type.Array(ChatMessageSchema));
/**
 * The scheduled tasks still waiting, soonest first; null while this machine doesn't hold the conversation open or
 * hasn't read them yet, so the phone never takes an empty list it was not given for its notifications.
 */
export const ScheduledSchema = Type.Union([Type.ReadonlyObject(Type.Array(ScheduledTaskSchema)), Type.Null()]);
/**
 * Which server answers: `bundle` names its bundle (the first 32 hex digits of its SHA-256), built with these pi
 * versions, running as the device `--device` named. The phone reinstalls when `bundle` differs from its manifest, and
 * never moves a conversation to another bundle, because pi-durable's SQLite migrations are one-way.
 */
export const ServerSchema = Type.Object({
  bundle: Type.String(),
  pi: Type.Object({ durable: Type.String(), ai: Type.String(), chord: Type.String() }),
  device: Type.String(),
  /** The device's description, the text the phone's device list gives the machine. */
  description: Type.String(),
});
export type InfiniChatServer = Static<typeof ServerSchema>;

const FileSchema = Type.Object({ sha256: Type.String(), size: Type.Number() });
/** The conversation's database file, its WAL folded into it, by SHA-256 and size. */
export const ConversationFilesSchema = Type.Object({ db: FileSchema });
export type ConversationFiles = Static<typeof ConversationFilesSchema>;
/**
 * Who can hold the conversation: a phone, by the client ID it keeps and the name it gives itself, or a machine another
 * machine hands it to directly, by its endpoint (`machineEndpoint`) and its name.
 */
export const ClientSchema = Type.Object({ id: Type.String(), name: Type.String() });
export type InfiniChatClient = Static<typeof ClientSchema>;
/**
 * Whether this machine holds the conversation open, and the files it adopted then. Only the side that holds it opens
 * its database: the server opens it only while `active`, and a phone's home record says whether that phone holds it.
 * `heldBy` is the phone this machine handed it to, from `relinquish` until an `adopt` here, so every client reads
 * where it went.
 */
export const ConversationSchema = Type.Object({ active: Type.Boolean(),
  adopted: Type.Optional(ConversationFilesSchema), heldBy: Type.Optional(ClientSchema) });
export type ConversationState = Static<typeof ConversationSchema>;

/** An SSH host key as Remote machines shows it: its algorithm and OpenSSH's `SHA256:` fingerprint. */
const HostKeySchema = Type.Object({ algorithm: Type.String(), fingerprint: Type.String() });
/**
 * A machine of the conversation, which a server's tools reach with its own SSH (pi-env): the name the machine gives
 * itself, its endpoint, the host key a client accepted for it (trust on first use, decided once), its own InfiniChat
 * key and the machines' keys authorized there by the key exchange (`keys.ts`), as `authorized_keys` matches them: a
 * change is worth another check. Never its credentials, which each client keeps for itself.
 */
export const MachineSchema = Type.Object({
  name: Type.String(), hostname: Type.String(), port: Type.Number(), username: Type.String(),
  hostKey: Type.Optional(HostKeySchema), publicKey: Type.Optional(Type.String()),
  authorizedKeys: Type.Optional(Type.Array(Type.String())),
});
export type Machine = Static<typeof MachineSchema>;
/** The conversation's machines document (`machines.ts`), by endpoint; null while the machine doesn't hold it. */
export const MachinesSchema = Type.Union([
  Type.Object({ machines: Type.Record(Type.String(), MachineSchema) }), Type.Null(),
]);
/** What a check or an accepted host key changes on a record. */
export const MachinePatchSchema = Type.Partial(Type.Pick(MachineSchema, ['name', 'publicKey', 'authorizedKeys', 'hostKey']));
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
export const ReachSchema = Type.Record(Type.String(), Type.Union([
  Type.Object({ reachable: Type.Literal(true) }),
  Type.Object({ reachable: Type.Literal(false), error: Type.String() }),
]));
export type Reach = Static<typeof ReachSchema>;
/**
 * Per machine endpoint, the host keys the server's scan found that it doesn't trust, which only a client can accept;
 * `changed` when they replace a key it trusted.
 */
export const PendingHostKeysSchema = Type.Record(Type.String(),
  Type.Object({ keys: Type.Array(HostKeySchema), changed: Type.Boolean() }));
export type PendingHostKeys = Static<typeof PendingHostKeysSchema>;

/** The provider sign-ins of the machine's own credential store, keyed by provider. */
export const AccessSchema = Type.Record(Type.String(), ProviderAccessSchema);
/** pi-ai's `AuthPrompt` without its signal, which stays on the server. */
const AuthPromptSchema = Type.Union([
  Type.Object({
    type: Type.Enum(['text', 'secret', 'manual_code']), message: Type.String(),
    placeholder: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal('select'), message: Type.String(),
    options: Type.ReadonlyObject(Type.Array(Type.Object({
      id: Type.String(), label: Type.String(), description: Type.Optional(Type.String()),
    }))),
  }),
]);
/**
 * The machine's latest sign-in, until the next one starts; null before its first. `status` is the account screen's
 * public copy, absent once an attempt succeeded, as that screen clears its notice. While it runs, `url` is pi-ai's
 * `auth_url`, and `prompt` waits for `answer` with its `id`. An attempt that ended stays, so a phone that learns its
 * attempt's number before its state still finds how it ended.
 */
export const SignInAttemptSchema = Type.Union([Type.Null(), Type.Object({
  attempt: Type.Number(),
  providerId: Type.String(),
  running: Type.Boolean(),
  status: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.Object({ id: Type.Number(), prompt: AuthPromptSchema })),
})]);
export type SignInAttempt = Static<typeof SignInAttemptSchema>;

/**
 * InfiniChat as the machine that runs its Harness serves it: the same view, controls and transcript the phone shows,
 * and the operations of its screens.
 */
export const InfiniChatRemote = remote('infinichat.remote', {
  version: 4,
  input: Type.Object({}),
  host: hostNamed('infinichat-server'),
  variants: {
    owner: {
      state: {
        snapshot: SnapshotSchema, controls: ControlsSchema, messages: MessagesSchema, scheduled: ScheduledSchema,
        server: ServerSchema, conversation: ConversationSchema, catalog: ModelCatalogSchema, access: AccessSchema,
        // Not `signIn`, the method that starts one: Chord refuses a member that is both (`src/contract.ts:237`).
        signInAttempt: SignInAttemptSchema,
        machines: MachinesSchema, reach: ReachSchema, pendingHostKeys: PendingHostKeysSchema,
      },
      methods: {
        accept: method(Type.Object({ content: UserInputSchema, requestId: Type.String() })),
        stop: method(),
        updateSettings: method(Type.Object({
          main: ChatModelSettingsSchema, summary: ChatModelSettingsSchema, instructions: Type.String(),
          name: Type.String(),
        })),
        cancelScheduled: method(Type.Object({ id: Type.Number(), replacement: Type.Optional(ScheduledInputSchema) }),
          Type.Boolean()),
        dismissError: method(),
        // The phone's IANA zone, sent on every connect, so the times the agent reads match the phone's clock.
        setTimeZone: method(Type.Object({ zone: Type.String() })),
        // The account screen's operations on the machine's credential store. `signIn` starts an attempt and returns
        // its number; the attempt runs on the server, and its prompts are answered by separate calls.
        signIn: method(Type.Object({ providerId: Type.String() }), Type.Number()),
        answer: method(Type.Object({ promptId: Type.Number(), value: Type.String() })),
        cancelSignIn: method(),
        setApiKey: method(Type.Object({ providerId: Type.String(), key: Type.String() })),
        signOut: method(Type.Object({ providerId: Type.String() })),
        // Moving the conversation, as upstream's session sync hands a session over: one side closes its Harness, the
        // files are copied, the other side opens them. `adopt` opens the files in `data/` when they match, and is
        // refused while active; it clears `heldBy`. `relinquish` (Chord reserves `release`) records the phone it
        // hands the conversation `to` as `heldBy`, stops input, closes the Harness and its storage, and names the files
        // it left; called again with the same phone, it names them again, and with another it is refused, so one
        // handover runs at a time. `archive` keeps the released database as the machine's copy, which nothing opens,
        // and `heldBy` with it; it is refused while active.
        adopt: method(ConversationFilesSchema),
        relinquish: method(Type.Object({ to: ClientSchema }), ConversationFilesSchema),
        archive: method(),
        // `pull` brings the database another machine (`from`, as the conversation there lists it, since this one has
        // no conversation open to read it from) released into `data/`, read over this machine's own SSH, once it
        // matches `files`; refused while active, as a phone's upload is. A move between two machines is relinquish
        // there, pull and adopt here, then archive there, with a client orchestrating.
        pull: method(Type.Object({ from: MachineSchema, files: ConversationFilesSchema })),
        // The conversation's machines document, edited through the side that holds it: a record whole, part of one
        // (what a check found, an accepted host key), or its removal. `acceptHostKey` trusts the pending keys with
        // these fingerprints here and records the key on the machine, so the next holder trusts it too.
        putMachine: method(MachineSchema),
        patchMachine: method(Type.Object({ endpoint: Type.String(), patch: MachinePatchSchema })),
        removeMachine: method(Type.Object({ endpoint: Type.String() })),
        acceptHostKey: method(Type.Object({ endpoint: Type.String(), fingerprints: Type.Array(Type.String()) })),
      },
    },
  },
});
