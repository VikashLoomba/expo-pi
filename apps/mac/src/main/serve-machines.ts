import type { Host } from '@earendil-works/chord';
import { Type } from '@earendil-works/pi-ai';
import {
  MachinesSchema, PendingHostKeysSchema, ReachSchema,
} from '@pi-agent/infinichat/pi/infinichat-remote/contract';

import { CheckSchema, MacMachines, type MacPrincipal } from '../contract';
import type { MacInfiniChat } from './infinichat';
import type { MacMachines as Machines } from './machines';

const ChecksSchema = Type.Record(Type.String(), CheckSchema);
const IdentitiesSchema = Type.Record(Type.String(), Type.String());
const ReachCell = Type.Union([Type.Null(), ReachSchema]);
const PendingCell = Type.Union([Type.Null(), PendingHostKeysSchema]);

/**
 * Serves the machines to the Settings window: the document and what the holder found of each from the shown side,
 * this Mac's checks and identity files from the manager, as `serve-infinichat.ts` serves the conversation.
 */
export function serveMachines(host: Host<MacPrincipal>, infinichat: MacInfiniChat, machines: Machines): void {
  const { shown } = infinichat;
  host.serve(MacMachines, (_input, _principal, self) => {
    const currentMachines = () => shown.machines.getSnapshot() ?? null;
    const currentReach = () => infinichat.getReach() ?? null;
    const currentPending = () => infinichat.getPendingHostKeys() ?? null;
    const list = self.state('machines', MachinesSchema, { init: currentMachines });
    const reach = self.state('reach', ReachCell, { init: currentReach });
    const pendingHostKeys = self.state('pendingHostKeys', PendingCell, { init: currentPending });
    const checks = self.state('checks', ChecksSchema, { init: machines.getChecks });
    const identities = self.state('identities', IdentitiesSchema, { init: machines.getIdentities });
    const own = self.state('self', Type.String(), { init: machines.getSelf });
    self.on('machines', shown.machines, (_change, ctx) => {
      list.replace(ctx, currentMachines(), { diff: true });
      own.replace(ctx, machines.getSelf(), { diff: true });
      machines.putSelf();
    });
    self.on('reach', infinichat, (_change, ctx) => {
      reach.replace(ctx, currentReach(), { diff: true });
      pendingHostKeys.replace(ctx, currentPending(), { diff: true });
    });
    self.on('checks', machines, (_change, ctx) => {
      checks.replace(ctx, machines.getChecks(), { diff: true });
      identities.replace(ctx, machines.getIdentities(), { diff: true });
    });
    return {
      variant: 'owner',
      machines: list,
      reach,
      pendingHostKeys,
      checks,
      identities,
      self: own,
      save: (form) => machines.save(form),
      remove: ({ endpoint }) => machines.remove(endpoint),
      check: ({ endpoint }) => { machines.check(endpoint); },
      cancelCheck: ({ endpoint }) => { machines.cancelCheck(endpoint); },
      trustNewKey: ({ endpoint }) => machines.trustNewKey(endpoint),
      acceptHostKey: ({ endpoint, fingerprints }) => infinichat.acceptHostKey(endpoint, fingerprints),
      setIdentity: ({ endpoint, path }) => { machines.setIdentity(endpoint, path); },
      pickIdentityFile: () => machines.pickIdentityFile(),
    };
  });
}
