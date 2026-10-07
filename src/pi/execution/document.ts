import { defineDoc, type AgentState, type JsonObject } from '@earendil-works/pi-durable';

export type ExecutionTarget = { kind: 'local' } | { kind: 'ssh'; machineId: string };
export type ExecutionTargetState = { target: ExecutionTarget };
export type ChatExecutionSettings = { target: ExecutionTarget; cwd: string };

/** Version 1 stored the target as the document root. Anything unreadable falls back to this device. */
function readTargetV1(value: JsonObject): ExecutionTarget {
  return value.kind === 'ssh' && typeof value.machineId === 'string'
    ? { kind: 'ssh', machineId: value.machineId } : { kind: 'local' };
}

/**
 * Configuration follows agent history; filesystem contents do not. The target sits under `target` so a commit can
 * replace it whole: a draft cannot turn one variant of a root union into another.
 */
export const ExecutionTargetDoc = defineDoc<ExecutionTargetState>({
  kind: 'app.execution-target', version: 2, scope: 'conversation',
  history: 'rewindable', fork: 'asOf', initial: () => ({ target: { kind: 'local' } }),
  migrate: (value) => ({ target: readTargetV1(value) }),
});

export function executionSettings(state?: Readonly<ExecutionTargetState> | null,
  agent?: Pick<AgentState, 'cwd'> | null): ChatExecutionSettings {
  const target = state?.target;
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
