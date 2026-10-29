import { hostNamed, method, remote } from '@earendil-works/chord';
import { Type, type Static } from '@earendil-works/pi-ai';
import { ChatControlsSchema } from '@pi-agent/infinichat/chat/types';
import { ChatExecutionSettingsSchema } from '@pi-agent/infinichat/pi/execution/document';
import {
  AccessSchema, ControlsSchema, ConversationSchema, MachinesSchema, MessagesSchema, PendingHostKeysSchema,
  ReachSchema, ScheduledSchema, SignInAttemptSchema, SnapshotSchema,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { ScheduledInputSchema } from '@pi-agent/infinichat/pi/infinichat/schedule';
import { ChatModelSettingsSchema, ModelCatalogSchema } from '@pi-agent/infinichat/pi/model-catalog';
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
      methods: {
        // Links open in the default browser under the phone's policy (`source-link.ts`): a page can't open them.
        openExternal: method(Type.Object({ url: Type.String() })),
        // The Settings window, as the menu's Settings… opens it.
        openSettings: method(),
      },
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
/** The machine whose InfiniChat the windows show: its endpoint and its name. */
export const ShownMachineSchema = Type.Union([Type.Null(), Type.Object({ id: Type.String(), name: Type.String() })]);
/** A move between machines as `InfiniChatMoves` reports it (`move.ts`), while it runs and after a failure. */
export const MoveStatusSchema = Type.Object({
  machineId: Type.String(),
  to: Type.Enum(['machine', 'phone']),
  from: Type.Optional(Type.String()),
  step: Type.Enum(['connecting', 'closing', 'copying', 'opening']),
  copied: Type.Optional(Type.Object({ bytes: Type.Number(), total: Type.Number() })),
  running: Type.Boolean(),
  error: Type.Optional(Type.String()),
  cancellable: Type.Boolean(),
  undoing: Type.Optional(Type.Boolean()),
});
export type MoveStatus = Static<typeof MoveStatusSchema>;

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
        // The conversation's machines, the move under way, and what the last move wants the user to know.
        machines: MachinesSchema, move: Type.Union([Type.Null(), MoveStatusSchema]),
        moveNotice: Type.Union([Type.Null(), Type.String()]),
        // Piece 6: the holder machine's providers and models and its sign-in under way, as `RemoteInfiniChat` reads
        // them, and this Mac's own avatar file as the page loads it (`appdata://avatar/<file>`).
        catalog: ModelCatalogSchema, access: AccessSchema, signInAttempt: SignInAttemptSchema,
        avatar: Type.Union([Type.Null(), Type.String()]),
      },
      methods: {
        accept: method(Type.Object({ content: UserInputSchema, requestId: Type.String() })),
        stop: method(),
        dismissError: method(),
        dismissNotice: method(),
        reconnect: method(),
        // Moving the conversation to a listed machine from the one it lives on, as the phone's menu does.
        chooseMove: method(Type.Object({ machineId: Type.String() })),
        cancelMove: method(),
        retryMove: method(),
        dismissMoveNotice: method(),
        // Photos for the composer, fitted to the shown model's limits by the main process: chosen in the file
        // dialog, or handed over by the page (dropped or pasted), as base64.
        pickPhotos: method(undefined, Type.Array(AttachmentSchema)),
        attach: method(Type.Object({ name: Type.String(), mimeType: Type.String(), data: Type.String() }),
          AttachmentSchema),
        // Piece 6: the settings and scheduled tasks sheets, through the side shown, and the avatar: a file chosen in
        // the open dialog becomes it at once (its URL comes back; null when nothing was chosen).
        updateSettings: method(Type.Object({ main: ChatModelSettingsSchema, summary: ChatModelSettingsSchema,
          instructions: Type.String(), name: Type.String() })),
        cancelScheduled: method(Type.Object({ id: Type.Number(), replacement: Type.Optional(ScheduledInputSchema) }),
          Type.Boolean()),
        setAvatar: method(undefined, Type.Union([Type.Null(), Type.String()])),
        clearAvatar: method(),
        // The providers sheet's operations on the holder machine's credential store, forwarded to its object.
        signIn: method(Type.Object({ providerId: Type.String() }), Type.Number()),
        answer: method(Type.Object({ promptId: Type.Number(), value: Type.String() })),
        cancelSignIn: method(),
        setApiKey: method(Type.Object({ providerId: Type.String(), key: Type.String() })),
        signOut: method(Type.Object({ providerId: Type.String() })),
      },
    },
  },
});

/** What a check of a machine from this Mac is doing, found, or ran into; one per endpoint while it matters. */
export const CheckSchema = Type.Object({
  stage: Type.Optional(Type.Enum(['connecting', 'approving', 'checking', 'exchanging'])),
  result: Type.Optional(Type.Object({ version: Type.String(), os: Type.String(), arch: Type.String(),
    name: Type.String() })),
  error: Type.Optional(Type.String()),
  /** The host key the machine presents, which differs from the one trusted here; only Trust new key goes on. */
  pendingKey: Type.Optional(Type.Object({
    keys: Type.Array(Type.Object({ algorithm: Type.String(), fingerprint: Type.String() })), changed: Type.Boolean(),
  })),
});
export type Check = Static<typeof CheckSchema>;
/** What the Settings window saves of a machine: its endpoint's parts; the machine names itself when checked. */
export const MachineFormSchema = Type.Object({
  hostname: Type.String(), port: Type.Number(), username: Type.String(),
  /** The endpoint the form opened with, whose record a changed endpoint replaces. */
  previous: Type.Optional(Type.String()),
});

/**
 * The conversation's machines as this Mac sees and reaches them: the document the shown side serves, what the
 * holder's server finds of each (`reach`, `pendingHostKeys`), this Mac's own checks from here over pi-env, the
 * identity file chosen for each, and this Mac's own endpoint among them.
 */
export const MacMachines = remote('infinichat.mac.machines', {
  version: 1,
  input: Type.Object({}),
  host: hostNamed('mac'),
  variants: {
    owner: {
      state: {
        machines: MachinesSchema,
        reach: Type.Union([Type.Null(), ReachSchema]),
        pendingHostKeys: Type.Union([Type.Null(), PendingHostKeysSchema]),
        checks: Type.Record(Type.String(), CheckSchema),
        identities: Type.Record(Type.String(), Type.String()),
        self: Type.String(),
        /** The endpoint of the machine InfiniChat runs on, whose row has nothing to reach from there. */
        holder: Type.Union([Type.Null(), Type.String()]),
      },
      methods: {
        save: method(MachineFormSchema),
        remove: method(Type.Object({ endpoint: Type.String() })),
        check: method(Type.Object({ endpoint: Type.String() })),
        cancelCheck: method(Type.Object({ endpoint: Type.String() })),
        trustNewKey: method(Type.Object({ endpoint: Type.String() })),
        acceptHostKey: method(Type.Object({ endpoint: Type.String(), fingerprints: Type.Array(Type.String()) })),
        setIdentity: method(Type.Object({ endpoint: Type.String(), path: Type.Union([Type.String(), Type.Null()]) })),
        pickIdentityFile: method(undefined, Type.Union([Type.String(), Type.Null()])),
      },
    },
  },
});

// ---- The Mac's own chats (piece 7) ----

/** A chat as the sidebar lists it: pi-durable's conversation ID as a number, resolved again on the main side. */
export const ChatSummarySchema = Type.Object({
  id: Type.Number(), title: Type.String(), preview: Type.String(), updatedAt: Type.Number(),
});
export type ChatSummaryRecord = Static<typeof ChatSummarySchema>;
/** One folder of a machine as the directory browser shows it, and what a search below one found. */
export const FolderSchema = Type.Object({ home: Type.String(), path: Type.String(), names: Type.Array(Type.String()) });
export const FolderSearchSchema = Type.Object({ matches: Type.Array(Type.String()), stoppedEarly: Type.Boolean() });

/**
 * This Mac's chats as the sidebar reads them: the list as `DurableChatService` keeps it (null until the service
 * opens), a failed open or the Harness's latest report, and the list's operations.
 */
export const MacChats = remote('infinichat.mac.chats', {
  version: 1,
  input: Type.Object({}),
  host: hostNamed('mac'),
  variants: {
    owner: {
      state: {
        chats: Type.Union([Type.Null(), Type.Array(ChatSummarySchema)]),
        // Named `report`, as `MacInfiniChat`'s is: a reference itself has `error`, which Chord reserves.
        report: Type.Union([Type.Null(), Type.String()]),
      },
      methods: {
        createChat: method(undefined, Type.Object({ id: Type.String() })),
        rename: method(Type.Object({ id: Type.String(), title: Type.String() })),
        delete: method(Type.Object({ id: Type.String() })),
        dismissError: method(),
      },
    },
  },
});

/**
 * One chat while a window shows it: its view's cells, as the phone's `useChatView` reads them, and its screen's and
 * settings sheet's operations. The object attaches the view at its first hold and releases it with its last.
 */
export const MacChat = remote('infinichat.mac.chat', {
  version: 1,
  input: Type.Object({ id: Type.String() }),
  host: hostNamed('mac'),
  variants: {
    owner: {
      state: {
        snapshot: SnapshotSchema, controls: Type.Union([ChatControlsSchema, Type.Null()]), messages: MessagesSchema,
      },
      methods: {
        send: method(Type.Object({ content: UserInputSchema, requestId: Type.String() })),
        cancel: method(),
        // A queued follow-up sent again as a steer, from its row.
        steer: method(Type.Object({ submissionId: Type.Number(), content: UserInputSchema })),
        // The chat's parked tasks, which its controls list, run again.
        retryParked: method(),
        updateSettings: method(Type.Object({ settings: ChatModelSettingsSchema })),
        updateExecution: method(Type.Object({
          execution: ChatExecutionSettingsSchema, settings: Type.Optional(ChatModelSettingsSchema),
        })),
        // The directory browser over a machine, and the open dialog for a folder on this Mac.
        listFolder: method(Type.Object({ machineId: Type.String(), path: Type.Union([Type.String(), Type.Null()]) }),
          FolderSchema),
        searchFolders: method(Type.Object({ machineId: Type.String(), root: Type.String(), query: Type.String() }),
          FolderSearchSchema),
        chooseLocalFolder: method(undefined, Type.Union([Type.String(), Type.Null()])),
        // Photos fitted to the chat's model, as `MacInfiniChat` fits them to InfiniChat's.
        pickPhotos: method(undefined, Type.Array(AttachmentSchema)),
        attach: method(Type.Object({ name: Type.String(), mimeType: Type.String(), data: Type.String() }),
          AttachmentSchema),
      },
    },
  },
});

/**
 * This Mac's own providers: the catalog its chats choose from and each provider's access, as the machine's server
 * sends its own to the phone. Piece 8 adds the sign-ins.
 */
export const MacAccount = remote('infinichat.mac.account', {
  version: 1,
  input: Type.Object({}),
  host: hostNamed('mac'),
  variants: {
    owner: {
      state: { catalog: ModelCatalogSchema, access: AccessSchema },
      methods: { refreshCatalog: method() },
    },
  },
});
