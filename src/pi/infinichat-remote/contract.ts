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

/** Who acts on the server: the phone, its one client, or the server's own code. */
export type InfiniChatPrincipal = { kind: 'owner' } | { kind: 'host' };

/**
 * The view's snapshot and the Harness's latest report, until it is dismissed. Named `snapshot`: a reference itself
 * has `status`, which Chord reserves.
 */
export const SnapshotSchema = Type.Object({ view: ChatViewSnapshotSchema, report: Type.Optional(Type.String()) });
export const ControlsSchema = Type.Union([InfiniChatControlsSchema, Type.Null()]);
export const MessagesSchema = Type.ReadonlyObject(Type.Array(ChatMessageSchema));
export const ScheduledSchema = Type.ReadonlyObject(Type.Array(ScheduledTaskSchema));
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
/** The conversation's database file and the WAL beside it, if one remains, by SHA-256 and size. */
export const ConversationFilesSchema = Type.Object({ db: FileSchema, wal: Type.Optional(FileSchema) });
export type ConversationFiles = Static<typeof ConversationFilesSchema>;
/**
 * Whether this machine holds the conversation open, and the files it adopted then. Only the side that holds it opens
 * its database: the phone's home record decides who may, and the server opens it only while `active`.
 */
export const ConversationSchema = Type.Object({ active: Type.Boolean(),
  adopted: Type.Optional(ConversationFilesSchema) });
export type ConversationState = Static<typeof ConversationSchema>;

/** An SSH host key as Remote machines shows it: its algorithm and OpenSSH's `SHA256:` fingerprint. */
const HostKeySchema = Type.Object({ algorithm: Type.String(), fingerprint: Type.String() });
/**
 * Another configured machine, which the server's tools reach with the server's own SSH (pi-env), and the host key the
 * phone pinned for it, if any. Never its credentials.
 */
export const MachineSchema = Type.Object({
  id: Type.String(), name: Type.String(), hostname: Type.String(), port: Type.Number(), username: Type.String(),
  hostKey: Type.Optional(HostKeySchema),
});
export type Machine = Static<typeof MachineSchema>;
/** Per machine ID, whether the server reached it the last time it tried, and pi-env's error when it didn't. */
export const ReachSchema = Type.Record(Type.String(), Type.Union([
  Type.Object({ reachable: Type.Literal(true) }),
  Type.Object({ reachable: Type.Literal(false), error: Type.String() }),
]));
export type Reach = Static<typeof ReachSchema>;
/**
 * Per machine ID, the host keys the server's scan found that it doesn't trust, which only the phone can accept;
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
  version: 1,
  input: Type.Object({}),
  host: hostNamed('infinichat-server'),
  variants: {
    owner: {
      state: {
        snapshot: SnapshotSchema, controls: ControlsSchema, messages: MessagesSchema, scheduled: ScheduledSchema,
        server: ServerSchema, conversation: ConversationSchema, catalog: ModelCatalogSchema, access: AccessSchema,
        // Not `signIn`, the method that starts one: Chord refuses a member that is both (`src/contract.ts:237`).
        signInAttempt: SignInAttemptSchema,
        reach: ReachSchema, pendingHostKeys: PendingHostKeysSchema,
      },
      methods: {
        accept: method(Type.Object({ content: UserInputSchema, requestId: Type.String() })),
        stop: method(),
        updateSettings: method(Type.Object({
          main: ChatModelSettingsSchema, summary: ChatModelSettingsSchema, instructions: Type.String(),
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
        // refused while active. `relinquish` (Chord reserves `release`) stops input, closes the Harness and its
        // storage, and names the files it left; called again, it names them again. `archive` moves released files
        // where nothing opens them, and is refused while active.
        adopt: method(ConversationFilesSchema),
        relinquish: method(undefined, ConversationFilesSchema),
        archive: method(),
        // The other machines, sent on every connect and whenever Remote machines change; the server keeps them for
        // its tools while the phone is away. `acceptHostKey` trusts the pending keys with these fingerprints.
        setMachines: method(Type.Object({ machines: Type.Array(MachineSchema) })),
        acceptHostKey: method(Type.Object({ id: Type.String(), fingerprints: Type.Array(Type.String()) })),
      },
    },
  },
});
