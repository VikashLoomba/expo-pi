import { hostNamed, method, remote } from '@earendil-works/chord';
import { Type, type Static } from '@earendil-works/pi-ai';
import {
  ControlsSchema, ConversationSchema, MessagesSchema, ScheduledSchema, SnapshotSchema,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { ChatImageSchema, UserInputSchema } from '@pi-agent/infinichat/pi/user-input';

/** Who acts on the main process's objects: a window, or the main process's own code. */
export type MacPrincipal = { kind: 'owner' } | { kind: 'host' };
export const principalKey = (principal: MacPrincipal) => principal.kind;

/** What the app is: its version and where it keeps its data, for the sidebar's footer. */
export const AboutSchema = Type.Object({ version: Type.String(), userData: Type.String() });
export type About = Static<typeof AboutSchema>;

/**
 * The Mac app as its main process serves it to its windows. Every window acts as the owner, so all of them share one
 * object. Later pieces add InfiniChat, the chats, the account and the machines as objects of their own.
 */
export const MacApp = remote('infinichat.mac', {
  version: 1,
  input: Type.Object({}),
  host: hostNamed('mac'),
  variants: {
    owner: {
      state: { about: AboutSchema },
      // Links open in the default browser under the phone's policy (`source-link.ts`): a page can't open them.
      methods: { openExternal: method(Type.Object({ url: Type.String() })) },
    },
  },
});

/** A photo fitted to the model, as the composer shows it and `accept` sends it: pi-ai's image part with an ID. */
export const AttachmentSchema = Type.Object({ ...ChatImageSchema.properties, id: Type.String() });
export type Attachment = Static<typeof AttachmentSchema>;

/** This app's connection to the machine shown, as `RemoteInfiniChat` reports it; null before a machine is shown. */
export const ConnectionSchema = Type.Union([Type.Null(), Type.Object({
  status: Type.Enum(['connecting', 'connected', 'failed']),
  stage: Type.Optional(Type.Enum(['connecting', 'checking', 'uploading', 'starting'])),
  error: Type.Optional(Type.String()),
  notice: Type.Optional(Type.String()),
})]);
export type Connection = Static<typeof ConnectionSchema>;
/** The machine whose InfiniChat the windows show: its ID in the app's list and its name. */
export const ShownMachineSchema = Type.Union([Type.Null(), Type.Object({ id: Type.String(), name: Type.String() })]);

/**
 * InfiniChat as this app shows it, wherever its Harness runs: the cells of the machine's remote object as
 * `ShownInfiniChat` carries them across moves, the connection to that machine, and the operations of its screen.
 */
export const MacInfiniChat = remote('infinichat.mac.conversation', {
  version: 1,
  input: Type.Object({}),
  host: hostNamed('mac'),
  variants: {
    owner: {
      state: {
        snapshot: SnapshotSchema, controls: ControlsSchema, messages: MessagesSchema, scheduled: ScheduledSchema,
        connection: ConnectionSchema, held: Type.Union([Type.Null(), ConversationSchema]), machine: ShownMachineSchema,
      },
      methods: {
        accept: method(Type.Object({ content: UserInputSchema, requestId: Type.String() })),
        stop: method(),
        dismissError: method(),
        dismissNotice: method(),
        reconnect: method(),
        // Photos for the composer, fitted to the shown model's limits by the main process: chosen in the file
        // dialog, or handed over by the page (dropped or pasted), as base64.
        pickPhotos: method(undefined, Type.Array(AttachmentSchema)),
        attach: method(Type.Object({ name: Type.String(), mimeType: Type.String(), data: Type.String() }),
          AttachmentSchema),
      },
    },
  },
});
