import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineDoc, type DocumentState, type Harness } from '@earendil-works/pi-durable';

import { machineEndpoint, type Machine } from './contract';

/** The machines of the conversation, by endpoint (`machineEndpoint`). */
export type MachinesState = { machines: Record<string, Machine> };

/**
 * The machines InfiniChat's tools reach and the conversation can move to, as state of the conversation: one document
 * of its storage, which the side that holds the conversation serves to every client and which moves with the
 * database (pi-durable README "Your Own State"). A record is what a server needs to reach the machine with its own
 * SSH and what the clients show: never a credential, which each client keeps for itself.
 */
export const MachinesDoc = defineDoc<MachinesState>({
  kind: 'infinichat.machines', version: 1, scope: 'session', checkpointWhen: () => true,
  initial: () => ({ machines: {} }),
});

/** What `patchMachine` may change: what a check finds (the name, the keys) and the host key a client accepted. */
export type MachinePatch = Partial<Pick<Machine, 'name' | 'publicKey' | 'authorizedKeys' | 'hostKey'>>;

/**
 * Adds or replaces the record at its endpoint. A name another machine has is refused:
 * the device list names devices.
 */
export async function putMachine(harness: Harness, record: Machine, context = BACKGROUND_CONTEXT): Promise<void> {
  const endpoint = machineEndpoint(record);
  await harness.commit(async (tx) => {
    const { machines } = await tx.doc(MachinesDoc);
    const taken = Object.entries(machines).find(([key, other]) => key !== endpoint && other.name === record.name);
    if (taken) throw new Error(`${record.name} is already the name of another machine (${taken[0]}).`);
    machines[endpoint] = { ...record };
  }, context);
}

/** Changes part of a listed machine's record; a machine removed meanwhile stays removed. */
export async function patchMachine(harness: Harness, endpoint: string, patch: MachinePatch,
  context = BACKGROUND_CONTEXT): Promise<void> {
  await harness.commit(async (tx) => {
    const { machines } = await tx.doc(MachinesDoc);
    const machine = machines[endpoint];
    if (machine === undefined) throw new Error(`${endpoint} is no longer among the machines.`);
    if (patch.name !== undefined) {
      const taken = Object.entries(machines).find(([key, other]) => key !== endpoint && other.name === patch.name);
      if (taken) throw new Error(`${patch.name} is already the name of another machine (${taken[0]}).`);
    }
    machines[endpoint] = { ...machine, ...patch };
  }, context);
}

export async function removeMachine(harness: Harness, endpoint: string, context = BACKGROUND_CONTEXT): Promise<void> {
  await harness.commit(async (tx) => {
    const { machines } = await tx.doc(MachinesDoc);
    delete machines[endpoint];
  }, context);
}

/**
 * The document as a store the screens and the server read, over its Chord state (`04-chord-state.ts`), which the
 * service creates with its first commit so the state is there to attach to.
 */
export class MachineList {
  private state?: DocumentState<MachinesState>;
  private value?: Readonly<MachinesState>;
  private readonly listeners = new Set<() => void>();
  private unsubscribe = () => {};
  private closed = false;

  constructor(private readonly harness: Harness) {}

  async start(): Promise<void> {
    if (await this.harness.snapshot(MachinesDoc, BACKGROUND_CONTEXT) === undefined) {
      await this.harness.commit(async (tx) => {
        await tx.doc(MachinesDoc);
      }, BACKGROUND_CONTEXT);
    }
    const state = await this.harness.documentState(MachinesDoc, BACKGROUND_CONTEXT);
    if (state === undefined) throw new Error('The machines of the conversation could not be read.');
    if (this.closed) {
      state.dispose();
      return;
    }
    this.state = state;
    this.value = state.value ?? undefined;
    this.unsubscribe = state.subscribe((value) => {
      // A session document never retires, so a null here never comes.
      this.value = value ?? undefined;
      for (const listener of [...this.listeners]) listener();
    });
    for (const listener of [...this.listeners]) listener();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  /** The machines by endpoint; undefined until first read. */
  readonly getSnapshot = () => this.value;

  close(): void {
    this.closed = true;
    this.unsubscribe();
    this.state?.dispose();
  }
}
