import { defineDoc, type AgentState } from '@earendil-works/pi-durable';

export type ExecutionTarget = { kind: 'local' } | { kind: 'ssh'; machineId: string };
export type ChatExecutionSettings = { target: ExecutionTarget; cwd: string };

/** Configuration follows agent history; filesystem contents do not. */
export const ExecutionTargetDoc = defineDoc<ExecutionTarget>({
  kind: 'app.execution-target', version: 1, scope: 'conversation',
  history: 'rewindable', fork: 'asOf', initial: () => ({ kind: 'local' }),
});

export function executionSettings(target?: Readonly<ExecutionTarget> | null, agent?: Readonly<AgentState> | null): ChatExecutionSettings {
  return { target: target?.kind === 'ssh' ? { kind: 'ssh', machineId: target.machineId } : { kind: 'local' },
    cwd: agent?.cwd ?? '/workspace' };
}

export function sameExecution(left: ChatExecutionSettings, right: ChatExecutionSettings): boolean {
  return left.cwd === right.cwd && left.target.kind === right.target.kind &&
    (left.target.kind !== 'ssh' || (right.target.kind === 'ssh' && left.target.machineId === right.target.machineId));
}

export function validateExecution(settings: ChatExecutionSettings): void {
  if (settings.target.kind !== 'local' && (settings.target.kind !== 'ssh' || !settings.target.machineId?.trim())) {
    throw new Error('Choose an execution environment.');
  }
  if (!settings.cwd.startsWith('/') || settings.cwd.includes('\0')) throw new Error('Enter an absolute working directory.');
  const parts: string[] = [];
  for (const part of settings.cwd.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  if (settings.target.kind === 'local' && parts[0] !== 'workspace') {
    throw new Error('The local working directory must be inside /workspace.');
  }
}
