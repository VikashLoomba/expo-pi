import type { Host } from '@earendil-works/chord';
import {
  AccessSchema, ControlsSchema, ConversationSchema, MachinesSchema, MessagesSchema, ScheduledSchema,
  SignInAttemptSchema, SnapshotSchema,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import {
  McpServerStatusSchema, McpSignInAttemptSchema,
} from '@pi-agent/infinichat/pi/infinichat-remote/mcp-contract';
import { ModelCatalogSchema, type ModelCatalog } from '@pi-agent/infinichat/pi/model-catalog';
import { arr, bool, nul, str, union } from '@earendil-works/pi-schema';

import {
  ConnectionSchema, MacInfiniChat, MacMcp, MoveStatusSchema, ShownMachineSchema, type Connection, type MacPrincipal,
} from '../contract';
import type { MacAvatar } from './avatar';
import type { MacInfiniChat as Shown } from './infinichat';

const LOADING = { status: 'loading' } as const;
const NO_CATALOG: ModelCatalog = [];
const NO_ACCESS = {};
const AvatarSchema = union([nul(), str()]);
const HeldSchema = union([nul(), ConversationSchema]);
const MoveSchema = union([nul(), MoveStatusSchema]);
const MoveNoticeSchema = union([nul(), str()]);

/** The connection as the contract carries it: a field that is absent is left out, as Chord requires. */
function connection(infinichat: Shown): Connection {
  const current = infinichat.getConnection();
  if (current === undefined) return null;
  return {
    status: current.status,
    ...(current.status === 'connecting' && current.stage !== undefined ? { stage: current.stage } : {}),
    ...(current.status === 'failed' ? { error: current.error } : {}),
    ...(current.notice === undefined ? {} : { notice: current.notice }),
  };
}

/**
 * Serves the shown InfiniChat to the windows as the server serves the open core to the phone (`serve.ts`): the cells
 * mirror `ShownInfiniChat`'s view and stores, the connection cells the client it follows; each write goes out as a
 * diff, the snapshot last. The screens' operations go to the side shown, which refuses while a move holds it.
 */
export function serveInfiniChat(host: Host<MacPrincipal>, infinichat: Shown, avatar: MacAvatar): void {
  const { shown } = infinichat;
  const view = shown.view();
  host.serve(MacInfiniChat, (_input, _principal, self) => {
    const currentSnapshot = () => {
      const { error } = shown.getSnapshot();
      return { view: view.getSnapshot() ?? LOADING, ...(error === undefined ? {} : { report: error }) };
    };
    const currentControls = () => view.getControls() ?? null;
    const currentScheduled = () => shown.scheduled.getSnapshot() ?? null;
    const currentHeld = () => infinichat.getHeld() ?? null;
    const currentMachine = () => infinichat.getMachine() ?? null;
    const currentMachines = () => shown.machines.getSnapshot() ?? null;
    const currentMove = () => infinichat.getMove() ?? null;
    const currentMoveNotice = () => infinichat.getMoveNotice() ?? null;
    const snapshot = self.state('snapshot', SnapshotSchema, { init: currentSnapshot });
    const controls = self.state('controls', ControlsSchema, { init: currentControls });
    const messages = self.state('messages', MessagesSchema, { init: () => view.getMessages() });
    const scheduled = self.state('scheduled', ScheduledSchema, { init: currentScheduled });
    const link = self.state('connection', ConnectionSchema, { init: () => connection(infinichat) });
    const held = self.state('held', HeldSchema, { init: currentHeld });
    const machine = self.state('machine', ShownMachineSchema, { init: currentMachine });
    const machines = self.state('machines', MachinesSchema, { init: currentMachines });
    const move = self.state('move', MoveSchema, { init: currentMove });
    const moveNotice = self.state('moveNotice', MoveNoticeSchema, { init: currentMoveNotice });
    // Piece 6: the holder's providers follow the client shown, as its connection does; the avatar is this Mac's.
    const currentCatalog = () => infinichat.getCatalog() ?? NO_CATALOG;
    const currentAccess = () => infinichat.getAccess() ?? NO_ACCESS;
    const currentSignIn = () => infinichat.getSignIn() ?? null;
    const currentAvatar = () => avatar.getSnapshot() ?? null;
    const catalog = self.state('catalog', ModelCatalogSchema, { init: currentCatalog });
    const access = self.state('access', AccessSchema, { init: currentAccess });
    const signInAttempt = self.state('signInAttempt', SignInAttemptSchema, { init: currentSignIn });
    const avatarUrl = self.state('avatar', AvatarSchema, { init: currentAvatar });
    self.on('shown', shown, (_change, ctx) => {
      messages.replace(ctx, view.getMessages(), { diff: true });
      controls.replace(ctx, currentControls(), { diff: true });
      scheduled.replace(ctx, currentScheduled(), { diff: true });
      snapshot.replace(ctx, currentSnapshot(), { diff: true });
    });
    self.on('connection', infinichat, (_change, ctx) => {
      link.replace(ctx, connection(infinichat), { diff: true });
      held.replace(ctx, currentHeld(), { diff: true });
      machine.replace(ctx, currentMachine(), { diff: true });
      catalog.replace(ctx, currentCatalog(), { diff: true });
      access.replace(ctx, currentAccess(), { diff: true });
      signInAttempt.replace(ctx, currentSignIn(), { diff: true });
    });
    self.on('avatar', avatar, (_change, ctx) => {
      avatarUrl.replace(ctx, currentAvatar(), { diff: true });
    });
    self.on('machines', shown.machines, (_change, ctx) => {
      machines.replace(ctx, currentMachines(), { diff: true });
    });
    self.on('move', infinichat.moves, (_change, ctx) => {
      move.replace(ctx, currentMove(), { diff: true });
      moveNotice.replace(ctx, currentMoveNotice(), { diff: true });
    });
    return {
      variant: 'owner',
      snapshot,
      controls,
      messages,
      scheduled,
      connection: link,
      held,
      machine,
      machines,
      move,
      moveNotice,
      catalog,
      access,
      signInAttempt,
      avatar: avatarUrl,
      accept: ({ content, requestId }) => shown.accept(content, requestId),
      stop: () => shown.stop(),
      continue: () => shown.continue(),
      loadEarlier: () => view.loadEarlier(),
      fillGap: (gap) => view.fillGap(gap),
      dismissError: () => shown.dismissError(),
      dismissNotice: () => infinichat.dismissNotice(),
      reconnect: () => infinichat.reconnect(),
      chooseMove: ({ machineId }) => { infinichat.chooseMove(machineId); },
      cancelMove: () => { infinichat.moves.cancel(); },
      retryMove: () => { infinichat.moves.retry(); },
      dismissMoveNotice: () => { infinichat.moves.dismissNotice(); },
      reloadPlugins: () => shown.reloadPlugins(),
      pickPhotos: () => infinichat.pickPhotos(),
      attach: ({ mimeType, data }) => infinichat.attach(Buffer.from(data, 'base64'), mimeType),
      updateSettings: (settings) => shown.updateSettings(settings),
      cancelScheduled: ({ id, replacement }) => shown.cancelScheduled(id, replacement),
      setAvatar: () => avatar.choose(),
      clearAvatar: () => { avatar.clear(); },
      signIn: ({ providerId }) => infinichat.signIn(providerId),
      answer: ({ promptId, value }) => infinichat.answer(promptId, value),
      cancelSignIn: () => infinichat.cancelSignIn(),
      setApiKey: ({ providerId, key }) => infinichat.setApiKey(providerId, key),
      signOut: ({ providerId }) => infinichat.signOut(providerId),
    };
  });
}

const UnavailableSchema = union([nul(), str()]);

/**
 * Serves the shown machine's MCP servers to the windows for the composer's `/mcp` sheet, as `serveInfiniChat` serves
 * the conversation: the cells mirror the shown client's `RemoteMcp`, and follow the next client when the conversation
 * moves; the operations go to that client's object.
 */
export function serveMcp(host: Host<MacPrincipal>, infinichat: Shown): void {
  const { mcp } = infinichat;
  host.serve(MacMcp, (_input, _principal, self) => {
    const currentMachine = () => infinichat.getMachine() ?? null;
    const currentLoaded = () => mcp.getSnapshot() !== undefined;
    const currentServers = () => [...mcp.getSnapshot()?.servers ?? []];
    const currentProblems = () => [...mcp.getSnapshot()?.problems ?? []];
    const currentSignIn = () => mcp.getSnapshot()?.signInAttempt ?? null;
    const currentUnavailable = () => mcp.unavailable() ?? mcp.getSnapshot()?.unavailable ?? null;
    const machine = self.state('machine', ShownMachineSchema, { init: currentMachine });
    const loaded = self.state('loaded', bool(), { init: currentLoaded });
    const servers = self.state('servers', arr(McpServerStatusSchema), { init: currentServers });
    const problems = self.state('problems', arr(str()), { init: currentProblems });
    const signInAttempt = self.state('signInAttempt', McpSignInAttemptSchema, { init: currentSignIn });
    const unavailable = self.state('unavailable', UnavailableSchema, { init: currentUnavailable });
    self.on('mcp', mcp, (_change, ctx) => {
      machine.replace(ctx, currentMachine(), { diff: true });
      loaded.replace(ctx, currentLoaded());
      servers.replace(ctx, currentServers(), { diff: true });
      problems.replace(ctx, currentProblems(), { diff: true });
      signInAttempt.replace(ctx, currentSignIn(), { diff: true });
      unavailable.replace(ctx, currentUnavailable());
    });
    return {
      variant: 'owner',
      machine,
      loaded,
      servers,
      problems,
      signInAttempt,
      unavailable,
      signIn: ({ server }) => mcp.signIn(server),
      answer: ({ promptId, value }) => mcp.answer(promptId, value),
      cancelSignIn: () => mcp.cancelSignIn(),
      signOut: ({ server }) => mcp.signOut(server),
      reconnect: ({ server }) => mcp.reconnect(server),
    };
  });
}
