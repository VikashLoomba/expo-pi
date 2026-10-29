import type { Host } from '@earendil-works/chord';
import {
  ControlsSchema, ConversationSchema, MachinesSchema, MemorySchema, MessagesSchema, ScheduledSchema, SnapshotSchema,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';
import { Type } from '@earendil-works/pi-ai';

import {
  ConnectionSchema, MacInfiniChat, MoveStatusSchema, ShownMachineSchema, type Connection, type MacPrincipal,
} from '../contract';
import type { MacInfiniChat as Shown } from './infinichat';

const LOADING = { status: 'loading' } as const;
const HeldSchema = Type.Union([Type.Null(), ConversationSchema]);
const MoveSchema = Type.Union([Type.Null(), MoveStatusSchema]);
const MoveNoticeSchema = Type.Union([Type.Null(), Type.String()]);

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
export function serveInfiniChat(host: Host<MacPrincipal>, infinichat: Shown): void {
  const { shown } = infinichat;
  const view = shown.view();
  host.serve(MacInfiniChat, (_input, _principal, self) => {
    const currentSnapshot = () => {
      const { error } = shown.getSnapshot();
      return { view: view.getSnapshot() ?? LOADING, ...(error === undefined ? {} : { report: error }) };
    };
    const currentControls = () => view.getControls() ?? null;
    const currentScheduled = () => shown.scheduled.getSnapshot() ?? null;
    const currentMemory = () => shown.memory.getSnapshot() ?? null;
    const currentHeld = () => infinichat.getHeld() ?? null;
    const currentMachine = () => infinichat.getMachine() ?? null;
    const currentMachines = () => shown.machines.getSnapshot() ?? null;
    const currentMove = () => infinichat.getMove() ?? null;
    const currentMoveNotice = () => infinichat.getMoveNotice() ?? null;
    const snapshot = self.state('snapshot', SnapshotSchema, { init: currentSnapshot });
    const controls = self.state('controls', ControlsSchema, { init: currentControls });
    const messages = self.state('messages', MessagesSchema, { init: () => view.getMessages() });
    const scheduled = self.state('scheduled', ScheduledSchema, { init: currentScheduled });
    const memory = self.state('memory', MemorySchema, { init: currentMemory });
    const link = self.state('connection', ConnectionSchema, { init: () => connection(infinichat) });
    const held = self.state('held', HeldSchema, { init: currentHeld });
    const machine = self.state('machine', ShownMachineSchema, { init: currentMachine });
    const machines = self.state('machines', MachinesSchema, { init: currentMachines });
    const move = self.state('move', MoveSchema, { init: currentMove });
    const moveNotice = self.state('moveNotice', MoveNoticeSchema, { init: currentMoveNotice });
    self.on('shown', shown, (_change, ctx) => {
      messages.replace(ctx, view.getMessages(), { diff: true });
      controls.replace(ctx, currentControls(), { diff: true });
      scheduled.replace(ctx, currentScheduled(), { diff: true });
      memory.replace(ctx, currentMemory(), { diff: true });
      snapshot.replace(ctx, currentSnapshot(), { diff: true });
    });
    self.on('connection', infinichat, (_change, ctx) => {
      link.replace(ctx, connection(infinichat), { diff: true });
      held.replace(ctx, currentHeld(), { diff: true });
      machine.replace(ctx, currentMachine(), { diff: true });
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
      memory,
      connection: link,
      held,
      machine,
      machines,
      move,
      moveNotice,
      accept: ({ content, requestId }) => shown.accept(content, requestId),
      stop: () => shown.stop(),
      dismissError: () => shown.dismissError(),
      dismissNotice: () => infinichat.dismissNotice(),
      reconnect: () => infinichat.reconnect(),
      chooseMove: ({ machineId }) => { infinichat.chooseMove(machineId); },
      cancelMove: () => { infinichat.moves.cancel(); },
      retryMove: () => { infinichat.moves.retry(); },
      dismissMoveNotice: () => { infinichat.moves.dismissNotice(); },
      pickPhotos: () => infinichat.pickPhotos(),
      attach: ({ mimeType, data }) => infinichat.attach(Buffer.from(data, 'base64'), mimeType),
    };
  });
}
