import { hostKind, method, remote, str as paramStr } from '@earendil-works/chord';
import { stringRecord } from '@earendil-works/pi-ai/providers/schema-builders';
import { arr, bool, lit, nul, num, obj, oneOf, opt, str, union, type Static } from '@earendil-works/pi-schema';
import { ChatControlsSchema } from '@pi-agent/infinichat/chat/types';
import { ChatExecutionSettingsSchema } from '@pi-agent/infinichat/pi/execution/document';
import {
  AccessSchema, ControlsSchema, ConversationSchema, MachinesSchema, MessagesSchema, PendingHostKeysSchema,
  ReachSchema, ScheduledSchema, SignInAttemptSchema, SnapshotSchema,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { McpServerStatusSchema, McpSignInAttemptSchema } from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';
import { ScheduledInputSchema } from '@pi-agent/infinichat/pi/infinichat/schedule';
import { ChatModelSettingsSchema, ModelCatalogSchema } from '@pi-agent/infinichat/pi/model-catalog';
import { ChatImageProperties, UserInputSchema } from '@pi-agent/infinichat/pi/user-input';

/** Who acts on the main process's objects: a window, or the main process's own code. */
export type MacPrincipal = { kind: 'owner' } | { kind: 'host' };
export const principalKey = (principal: MacPrincipal) => principal.kind;

/** The main process, the one addressable host of the app: its windows are clients (chord `docs/design.md` §3). */
export const MacMain = hostKind('mac');

/** What the app is: its version and where it keeps its data, for the sidebar's footer. */
export const AboutSchema = obj({ version: str(), userData: str() });
export type About = Static<typeof AboutSchema>;
/** A Settings pane to show and, for Providers, the provider to list first, as the phone's `account.tsx?provider=`. */
export const SettingsTargetSchema = obj({
  pane: oneOf(['machines', 'providers']), provider: opt(str()),
});
export type SettingsTarget = Static<typeof SettingsTargetSchema>;

/**
 * The Mac app as its main process serves it to its windows. Every window acts as the owner, so all of them share one
 * object. Later pieces add InfiniChat, the chats, the account and the machines as objects of their own.
 */
export const MacApp = remote('infinichat.mac', {
  version: 1,
  params: {},
  hostAddress: () => MacMain(),
  variants: {
    owner: {
      state: { about: AboutSchema },
      methods: {
        // Links open in the default browser under the phone's policy (`source-link.ts`): a page can't open them.
        openExternal: method(obj({ url: str() })),
        // The Settings window, as the menu's Settings… opens it: where it was, or at the pane a notice leads to.
        openSettings: method(obj({ target: opt(SettingsTargetSchema) })),
      },
    },
  },
});

/** A photo fitted to the model, as the composer shows it and `accept` sends it: pi-ai's image part with an ID. */
export const AttachmentSchema = obj({ ...ChatImageProperties, id: str() });
export type Attachment = Static<typeof AttachmentSchema>;

/** This app's connection to the machine shown, as `RemoteInfiniChat` reports it; null before a machine is shown. */
export const ConnectionSchema = union([nul(), obj({
  status: oneOf(['connecting', 'connected', 'failed']),
  stage: opt(oneOf(['connecting', 'checking', 'installing', 'starting'])),
  error: opt(str()),
  notice: opt(str()),
})]);
export type Connection = Static<typeof ConnectionSchema>;
/** The machine whose InfiniChat the windows show: its endpoint and its name. */
export const ShownMachineSchema = union([nul(), obj({ id: str(), name: str() })]);
const MoveFields = {
  machineId: str(),
  to: oneOf(['machine', 'phone']),
  from: opt(str()),
  step: oneOf(['connecting', 'closing', 'copying', 'opening']),
};
/** A move between machines as `InfiniChatMoves` reports it (`move-status.ts`), by phase. */
export const MoveStatusSchema = union([
  obj({ ...MoveFields, phase: lit('moving'), copied: opt(obj({ bytes: num(), total: num() })) }),
  obj({ ...MoveFields, phase: lit('failed'), error: str() }),
  obj({ ...MoveFields, phase: lit('undoing') }),
  obj({ ...MoveFields, phase: lit('undo-failed'), error: str() }),
]);
export type MoveStatus = Static<typeof MoveStatusSchema>;

/**
 * InfiniChat as this app shows it, wherever its Harness runs: the cells of the machine's remote object as
 * `ShownInfiniChat` carries them across moves, the connection to that machine, and the operations of its screen.
 */
export const MacInfiniChat = remote('infinichat.mac.conversation', {
  version: 1,
  params: {},
  hostAddress: () => MacMain(),
  variants: {
    owner: {
      state: {
        snapshot: SnapshotSchema, controls: ControlsSchema, messages: MessagesSchema, scheduled: ScheduledSchema,
        connection: ConnectionSchema, held: union([nul(), ConversationSchema]), machine: ShownMachineSchema,
        // The conversation's machines, the move under way, and what the last move wants the user to know.
        machines: MachinesSchema, move: union([nul(), MoveStatusSchema]),
        moveNotice: union([nul(), str()]),
        // Piece 6: the holder machine's providers and models and its sign-in under way, as `RemoteInfiniChat` reads
        // them, and this Mac's own avatar file as the page loads it (`appdata://avatar/<file>`).
        catalog: ModelCatalogSchema, access: AccessSchema, signInAttempt: SignInAttemptSchema,
        avatar: union([nul(), str()]),
      },
      methods: {
        accept: method(obj({ content: UserInputSchema, requestId: str() })),
        stop: method(),
        // The run `controls.runFailure` names, continued; the transcript's rows for entries not loaded, loaded.
        continue: method(),
        loadEarlier: method(),
        fillGap: method(obj({ after: num(), upTo: num() })),
        dismissError: method(),
        dismissNotice: method(),
        reconnect: method(),
        // Moving the conversation to a listed machine from the one it lives on, as the phone's menu does.
        chooseMove: method(obj({ machineId: str() })),
        cancelMove: method(),
        retryMove: method(),
        dismissMoveNotice: method(),
        // The composer's `/reload-plugins`: what reloading the plugins on the machine shown did.
        reloadPlugins: method(undefined, str()),
        // Photos for the composer, fitted to the shown model's limits by the main process: chosen in the file
        // dialog, or handed over by the page (dropped or pasted), as base64.
        pickPhotos: method(undefined, arr(AttachmentSchema)),
        attach: method(obj({ name: str(), mimeType: str(), data: str() }),
          AttachmentSchema),
        // Piece 6: the settings and scheduled tasks sheets, through the side shown, and the avatar: a file chosen in
        // the open dialog becomes it at once (its URL comes back; null when nothing was chosen).
        updateSettings: method(obj({ main: ChatModelSettingsSchema, summary: ChatModelSettingsSchema,
          instructions: str(), name: str(),
          subagents: union([ChatModelSettingsSchema, nul()]) })),
        cancelScheduled: method(obj({ id: num(), replacement: opt(ScheduledInputSchema) }),
          bool()),
        setAvatar: method(undefined, union([nul(), str()])),
        clearAvatar: method(),
        // The providers sheet's operations on the holder machine's credential store, forwarded to its object.
        signIn: method(obj({ providerId: str() }), num()),
        answer: method(obj({ promptId: num(), value: str() })),
        cancelSignIn: method(),
        setApiKey: method(obj({ providerId: str(), key: str() })),
        signOut: method(obj({ providerId: str() })),
      },
    },
  },
});

/**
 * The MCP servers of the machine shown, as `RemoteMcp` reads them from its server's `/mcp` object, for the composer's
 * `/mcp` sheet; its operations go to that object. `loaded` is false until the object is live. `unavailable` says why
 * there is nothing to show: the conversation isn't on a machine, or the machine's server is from before `/mcp`.
 */
export const MacMcp = remote('infinichat.mac.mcp', {
  version: 1,
  params: {},
  hostAddress: () => MacMain(),
  variants: {
    owner: {
      state: {
        machine: ShownMachineSchema,
        loaded: bool(),
        servers: arr(McpServerStatusSchema),
        problems: arr(str()),
        signInAttempt: McpSignInAttemptSchema,
        unavailable: union([nul(), str()]),
      },
      methods: {
        signIn: method(obj({ server: str() }), num()),
        answer: method(obj({ promptId: num(), value: str() })),
        cancelSignIn: method(),
        signOut: method(obj({ server: str() })),
        reconnect: method(obj({ server: str() })),
      },
    },
  },
});

const CheckStageSchema = oneOf(['connecting', 'approving', 'checking', 'exchanging']);
export type CheckStage = Static<typeof CheckStageSchema>;
const CheckResultSchema = obj({ version: str(), os: str(), arch: str(), name: str() });
export type CheckResult = Static<typeof CheckResultSchema>;
/** What a check of a machine from this Mac is doing, found, or ran into; one per endpoint while it matters. */
export const CheckSchema = union([
  obj({ state: lit('checking'), stage: CheckStageSchema }),
  obj({ state: lit('passed'), result: CheckResultSchema }),
  obj({
    state: lit('failed'), error: str(),
    /** The host key the machine presents, which differs from the one trusted here; only Trust new key goes on. */
    pendingKey: opt(obj({
      keys: arr(obj({ algorithm: str(), fingerprint: str() })), changed: bool(),
    })),
  }),
]);
export type Check = Static<typeof CheckSchema>;
/** What the Settings window saves of a machine: its endpoint's parts; the machine names itself when checked. */
export const MachineFormSchema = obj({
  hostname: str(), port: num(), username: str(),
  /** The endpoint the form opened with, whose record a changed endpoint replaces. */
  previous: opt(str()),
});

/**
 * The conversation's machines as this Mac sees and reaches them: the document the shown side serves, what the
 * holder's server finds of each (`reach`, `pendingHostKeys`), this Mac's own checks from here over pi-env, the
 * identity file chosen for each, and this Mac's own endpoint among them.
 */
export const MacMachines = remote('infinichat.mac.machines', {
  version: 1,
  params: {},
  hostAddress: () => MacMain(),
  variants: {
    owner: {
      state: {
        machines: MachinesSchema,
        reach: union([nul(), ReachSchema]),
        pendingHostKeys: union([nul(), PendingHostKeysSchema]),
        checks: stringRecord(CheckSchema),
        identities: stringRecord(str()),
        self: str(),
        /** The endpoint of the machine InfiniChat runs on, whose row has nothing to reach from there. */
        holder: union([nul(), str()]),
      },
      methods: {
        save: method(MachineFormSchema),
        remove: method(obj({ endpoint: str() })),
        check: method(obj({ endpoint: str() })),
        cancelCheck: method(obj({ endpoint: str() })),
        trustNewKey: method(obj({ endpoint: str() })),
        acceptHostKey: method(obj({ endpoint: str(), fingerprints: arr(str()) })),
        setIdentity: method(obj({ endpoint: str(), path: union([str(), nul()]) })),
        pickIdentityFile: method(undefined, union([str(), nul()])),
      },
    },
  },
});

// ---- The Mac's own chats (piece 7) ----

/** A chat as the sidebar lists it: pi-durable's conversation ID as a number, resolved again on the main side. */
export const ChatSummarySchema = obj({
  id: num(), title: str(), preview: str(), updatedAt: num(),
});
export type ChatSummaryRecord = Static<typeof ChatSummarySchema>;
/** One folder of a machine as the directory browser shows it, and what a search below one found. */
export const FolderSchema = obj({ home: str(), path: str(), names: arr(str()) });
export const FolderSearchSchema = obj({ matches: arr(str()), stoppedEarly: bool() });

/**
 * This Mac's chats as the sidebar reads them: the list as `DurableChatService` keeps it (null until the service
 * opens), a failed open or the Harness's latest report, and the list's operations.
 */
export const MacChats = remote('infinichat.mac.chats', {
  version: 1,
  params: {},
  hostAddress: () => MacMain(),
  variants: {
    owner: {
      state: {
        chats: union([nul(), arr(ChatSummarySchema)]),
        // Named `report`, as `MacInfiniChat`'s is.
        report: union([nul(), str()]),
      },
      methods: {
        createChat: method(undefined, obj({ id: str() })),
        rename: method(obj({ id: str(), title: str() })),
        delete: method(obj({ id: str() })),
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
  // Chord's own `str`: a params field is typed by Chord's builders; the schema is pi-schema's all the same.
  params: { id: paramStr() },
  hostAddress: () => MacMain(),
  variants: {
    owner: {
      state: {
        snapshot: SnapshotSchema, controls: union([ChatControlsSchema, nul()]), messages: MessagesSchema,
      },
      methods: {
        send: method(obj({ content: UserInputSchema, requestId: str() })),
        cancel: method(),
        // A queued follow-up sent again as a steer, from its row.
        steer: method(obj({ submissionId: num(), content: UserInputSchema })),
        // The run `controls.runFailure` names, continued; the transcript's rows for entries not loaded, loaded.
        continue: method(),
        loadEarlier: method(),
        fillGap: method(obj({ after: num(), upTo: num() })),
        updateSettings: method(obj({ settings: ChatModelSettingsSchema })),
        updateExecution: method(obj({
          execution: ChatExecutionSettingsSchema, settings: opt(ChatModelSettingsSchema),
        })),
        // The directory browser over a machine, and the open dialog for a folder on this Mac.
        listFolder: method(obj({ machineId: str(), path: union([str(), nul()]) }),
          FolderSchema),
        searchFolders: method(obj({ machineId: str(), root: str(), query: str() }),
          FolderSearchSchema),
        chooseLocalFolder: method(undefined, union([str(), nul()])),
        // Photos fitted to the chat's model, as `MacInfiniChat` fits them to InfiniChat's.
        pickPhotos: method(undefined, arr(AttachmentSchema)),
        attach: method(obj({ name: str(), mimeType: str(), data: str() }),
          AttachmentSchema),
      },
    },
  },
});

/**
 * This Mac's own providers: the catalog its chats choose from, each provider's access and the sign-in under way, as
 * the machine's server sends its own to the phone. The cells and methods are `MacInfiniChat`'s account ones, so the
 * Providers pane and the providers sheet share their list.
 */
export const MacAccount = remote('infinichat.mac.account', {
  version: 1,
  params: {},
  hostAddress: () => MacMain(),
  variants: {
    owner: {
      state: { catalog: ModelCatalogSchema, access: AccessSchema, signInAttempt: SignInAttemptSchema },
      methods: {
        refreshCatalog: method(),
        signIn: method(obj({ providerId: str() }), num()),
        answer: method(obj({ promptId: num(), value: str() })),
        cancelSignIn: method(),
        setApiKey: method(obj({ providerId: str(), key: str() })),
        signOut: method(obj({ providerId: str() })),
      },
    },
  },
});
