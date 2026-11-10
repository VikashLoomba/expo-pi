import type { FacetHost } from '@earendil-works/chord';
import type { ModelCatalog } from '@pi-agent/infinichat/pi/model-catalog';

import { MacInfiniChat, MacMcp, type Connection, type MacPrincipal } from '../contract';
import type { MacAvatar } from './avatar';
import type { MacInfiniChat as Shown } from './infinichat';
import { done, mirror } from './serve';

const LOADING = { status: 'loading' } as const;
const NO_CATALOG: ModelCatalog = [];
const NO_ACCESS = {};

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
 * Serves the shown InfiniChat to the windows as the server serves the open core to the phone (`facet.ts`): the members
 * mirror `ShownInfiniChat`'s view and stores, the connection members the client it follows, one value per store, so
 * what a store changes together reaches a window in one message. The screens' operations go to the side shown, which
 * refuses while a move holds it.
 */
export function serveInfiniChat(host: FacetHost<MacPrincipal>, infinichat: Shown, avatar: MacAvatar): void {
  const { shown } = infinichat;
  const view = shown.view();
  host.serve(MacInfiniChat, (_params, _principal, self) => {
    // The view, the scheduled tasks and the machines are one store, `ShownInfiniChat`'s.
    const conversation = mirror(self, [shown], () => {
      const { error } = shown.getSnapshot();
      return {
        snapshot: { view: view.getSnapshot() ?? LOADING, ...(error === undefined ? {} : { report: error }) },
        controls: view.getControls() ?? null,
        messages: view.getMessages(),
        scheduled: shown.scheduled.getSnapshot() ?? null,
        machines: shown.machines.getSnapshot() ?? null,
      };
    });
    // Piece 6: the holder's providers follow the client shown, as its connection does; the avatar is this Mac's.
    const link = mirror(self, [infinichat], () => ({
      connection: connection(infinichat),
      held: infinichat.getHeld() ?? null,
      machine: infinichat.getMachine() ?? null,
      catalog: infinichat.getCatalog() ?? NO_CATALOG,
      access: infinichat.getAccess() ?? NO_ACCESS,
      signInAttempt: infinichat.getSignIn() ?? null,
    }));
    const moves = mirror(self, [infinichat.moves], () => ({
      move: infinichat.getMove() ?? null, notice: infinichat.getMoveNotice() ?? null,
    }));
    const avatarUrl = mirror(self, [avatar], () => avatar.getSnapshot() ?? null);
    return {
      variant: 'owner',
      members: {
        snapshot: self.derive([conversation], ([value]) => value.snapshot),
        controls: self.derive([conversation], ([value]) => value.controls),
        // Chord's JSON arrays are mutable types; the copies keep their elements, which the diff compares by identity.
        messages: self.derive([conversation], ([value]) => [...value.messages]),
        scheduled: self.derive([conversation], ([value]) => value.scheduled && [...value.scheduled]),
        machines: self.derive([conversation], ([value]) => value.machines),
        connection: self.derive([link], ([value]) => value.connection),
        held: self.derive([link], ([value]) => value.held),
        machine: self.derive([link], ([value]) => value.machine),
        catalog: self.derive([link], ([value]) => value.catalog),
        access: self.derive([link], ([value]) => value.access),
        signInAttempt: self.derive([link], ([value]) => value.signInAttempt),
        move: self.derive([moves], ([value]) => value.move),
        moveNotice: self.derive([moves], ([value]) => value.notice),
        avatar: self.derive([avatarUrl], ([value]) => value),
        accept: async ({ content, requestId }) => done(shown.accept(content, requestId)),
        stop: async () => done(shown.stop()),
        continue: async () => done(shown.continue()),
        loadEarlier: async () => done(view.loadEarlier()),
        fillGap: async (gap) => done(view.fillGap(gap)),
        dismissError: async () => done(shown.dismissError()),
        dismissNotice: async () => done(infinichat.dismissNotice()),
        reconnect: async () => done(infinichat.reconnect()),
        chooseMove: async ({ machineId }) => done(infinichat.chooseMove(machineId)),
        cancelMove: async () => done(infinichat.moves.cancel()),
        retryMove: async () => done(infinichat.moves.retry()),
        dismissMoveNotice: async () => done(infinichat.moves.dismissNotice()),
        reloadPlugins: async () => shown.reloadPlugins(),
        pickPhotos: async () => infinichat.pickPhotos(),
        attach: async ({ mimeType, data }) => infinichat.attach(Buffer.from(data, 'base64'), mimeType),
        updateSettings: async (settings) => done(shown.updateSettings(settings)),
        cancelScheduled: async ({ id, replacement }) => shown.cancelScheduled(id, replacement),
        setAvatar: async () => avatar.choose(),
        clearAvatar: async () => done(avatar.clear()),
        signIn: async ({ providerId }) => infinichat.signIn(providerId),
        answer: async ({ promptId, value }) => done(infinichat.answer(promptId, value)),
        cancelSignIn: async () => done(infinichat.cancelSignIn()),
        setApiKey: async ({ providerId, key }) => done(infinichat.setApiKey(providerId, key)),
        signOut: async ({ providerId }) => done(infinichat.signOut(providerId)),
      },
    };
  });
}

/**
 * Serves the shown machine's MCP servers to the windows for the composer's `/mcp` sheet, as `serveInfiniChat` serves
 * the conversation: the members mirror the shown client's `RemoteMcp`, and follow the next client when the
 * conversation moves; the operations go to that client's object.
 */
export function serveMcp(host: FacetHost<MacPrincipal>, infinichat: Shown): void {
  const { mcp } = infinichat;
  host.serve(MacMcp, (_params, _principal, self) => {
    const servers = mirror(self, [mcp], () => {
      const view = mcp.getSnapshot();
      return {
        machine: infinichat.getMachine() ?? null,
        loaded: view !== undefined,
        servers: view?.servers ?? [],
        problems: view?.problems ?? [],
        signInAttempt: view?.signInAttempt ?? null,
        unavailable: mcp.unavailable() ?? view?.unavailable ?? null,
      };
    });
    return {
      variant: 'owner',
      members: {
        machine: self.derive([servers], ([value]) => value.machine),
        loaded: self.derive([servers], ([value]) => value.loaded),
        servers: self.derive([servers], ([value]) => [...value.servers]),
        problems: self.derive([servers], ([value]) => [...value.problems]),
        signInAttempt: self.derive([servers], ([value]) => value.signInAttempt),
        unavailable: self.derive([servers], ([value]) => value.unavailable),
        signIn: async ({ server }) => mcp.signIn(server),
        answer: async ({ promptId, value }) => done(mcp.answer(promptId, value)),
        cancelSignIn: async () => done(mcp.cancelSignIn()),
        signOut: async ({ server }) => done(mcp.signOut(server)),
        reconnect: async ({ server }) => done(mcp.reconnect(server)),
      },
    };
  });
}
