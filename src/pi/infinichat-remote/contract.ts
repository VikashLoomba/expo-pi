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
});
export type InfiniChatServer = Static<typeof ServerSchema>;

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
        server: ServerSchema, catalog: ModelCatalogSchema, access: AccessSchema,
        // Not `signIn`, the method that starts one: Chord refuses a member that is both (`src/contract.ts:237`).
        signInAttempt: SignInAttemptSchema,
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
      },
    },
  },
});
