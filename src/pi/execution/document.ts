import { defineDoc, type AgentState } from '@earendil-works/pi-durable';

export type ExecutionTarget = { kind: 'local' } | { kind: 'ssh'; machineId: string };
export type ExecutionTargetState = { target: ExecutionTarget };
/** `cwd: null` leaves the agent's directory unset, so a remote machine uses its account's home directory. */
export type ChatExecutionSettings = { target: ExecutionTarget; cwd: string | null };

/**
 * The target sits under `target` so a commit can replace it whole: a draft cannot turn one variant of a root union
 * into another.
 */
export const ExecutionTargetDoc = defineDoc<ExecutionTargetState>({
  kind: 'app.execution-target', version: 2, scope: 'conversation',
  history: 'latest', fork: 'initial', initial: () => ({ target: { kind: 'local' } }),
});

export function executionSettings(state?: Readonly<ExecutionTargetState> | null,
  agent?: Pick<AgentState, 'cwd'> | null): ChatExecutionSettings {
  const target = state?.target;
  if (target?.kind === 'ssh') return { target: { kind: 'ssh', machineId: target.machineId }, cwd: agent?.cwd ?? null };
  return { target: { kind: 'local' }, cwd: agent?.cwd ?? '/workspace' };
}

export function sameExecution(left: ChatExecutionSettings, right: ChatExecutionSettings): boolean {
  return left.cwd === right.cwd && left.target.kind === right.target.kind &&
    (left.target.kind !== 'ssh' || (right.target.kind === 'ssh' && left.target.machineId === right.target.machineId));
}

export function validateExecution(settings: ChatExecutionSettings): void {
  if (settings.target.kind !== 'local' && (settings.target.kind !== 'ssh' || !settings.target.machineId?.trim())) {
    throw new Error('Choose an execution environment.');
  }
  if (settings.cwd === null) {
    if (settings.target.kind === 'local') throw new Error('Enter a working directory inside /workspace.');
    return;
  }
  if (!settings.cwd.startsWith('/') || /[\x00-\x1f\x7f]/.test(settings.cwd)) {
    throw new Error('Enter an absolute working directory.');
  }
  const parts: string[] = [];
  for (const part of settings.cwd.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  if (settings.target.kind === 'local' && parts[0] !== 'workspace') {
    throw new Error('The local working directory must be inside /workspace.');
  }
}
