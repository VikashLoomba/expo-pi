import { hostNamed, method, remote } from '@earendil-works/chord';
import { Type, type Static } from '@earendil-works/pi-ai';

import { ChatMessageSchema } from '../../chat/types';
import { ChatViewSnapshotSchema } from '../chat-view';
import { ScheduledTaskSchema } from '../infinichat-scheduled';
import { InfiniChatControlsSchema } from '../infinichat-view';
import { ScheduledInputSchema } from '../infinichat/schedule';
import { ChatModelSettingsSchema } from '../model-catalog';
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
        server: ServerSchema,
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
      },
    },
  },
});
