import type { FacetHost } from '@earendil-works/chord';

import { MacMachines, type MacPrincipal } from '../contract';
import type { MacInfiniChat } from './infinichat';
import type { MacMachines as Machines } from './machines';
import { done, mirror } from './serve';

/**
 * Serves the machines to the Settings window: the document and what the holder found of each from the shown side,
 * this Mac's checks and identity files from the manager, as `serve-infinichat.ts` serves the conversation.
 */
export function serveMachines(host: FacetHost<MacPrincipal>, infinichat: MacInfiniChat, machines: Machines): void {
  const { shown } = infinichat;
  host.serve(MacMachines, (_params, _principal, self) => {
    const listed = mirror(self, [shown.machines], () => ({
      machines: shown.machines.getSnapshot() ?? null, self: machines.getSelf(),
    }));
    const found = mirror(self, [infinichat], () => ({
      reach: infinichat.getReach() ?? null,
      pendingHostKeys: infinichat.getPendingHostKeys() ?? null,
      holder: infinichat.getMachine()?.id ?? null,
    }));
    const own = mirror(self, [machines], () => ({
      checks: machines.getChecks(), identities: machines.getIdentities(),
    }));
    // While the Settings window shows the machines, this Mac lists itself in a document that lacks it: at the
    // document as it is, then at each change (chord `docs/design.md` §14, `on`).
    self.on(listed, () => machines.putSelf());
    return {
      variant: 'owner',
      members: {
        machines: self.derive([listed], ([value]) => value.machines),
        self: self.derive([listed], ([value]) => value.self),
        reach: self.derive([found], ([value]) => value.reach),
        pendingHostKeys: self.derive([found], ([value]) => value.pendingHostKeys),
        holder: self.derive([found], ([value]) => value.holder),
        checks: self.derive([own], ([value]) => value.checks),
        identities: self.derive([own], ([value]) => value.identities),
        save: async (form) => done(machines.save(form)),
        remove: async ({ endpoint }) => done(machines.remove(endpoint)),
        check: async ({ endpoint }) => done(machines.check(endpoint)),
        cancelCheck: async ({ endpoint }) => done(machines.cancelCheck(endpoint)),
        trustNewKey: async ({ endpoint }) => done(machines.trustNewKey(endpoint)),
        acceptHostKey: async ({ endpoint, fingerprints }) => done(infinichat.acceptHostKey(endpoint, fingerprints)),
        setIdentity: async ({ endpoint, path }) => done(machines.setIdentity(endpoint, path)),
        pickIdentityFile: async () => machines.pickIdentityFile(),
      },
    };
  });
}
