import { Type, type Static } from '@earendil-works/pi-ai';
import { defineDoc, type AgentState } from '@earendil-works/pi-durable';

const ExecutionTargetSchema = Type.Union([
  Type.Object({ kind: Type.Literal('local') }),
  Type.Object({ kind: Type.Literal('ssh'), machineId: Type.String() }),
]);
export type ExecutionTarget = Static<typeof ExecutionTargetSchema>;
export type ExecutionTargetState = { target: ExecutionTarget };
/** `cwd: null` leaves the agent's directory unset, so a remote machine uses its account's home directory. */
export const ChatExecutionSettingsSchema = Type.Object({
  target: ExecutionTargetSchema,
  cwd: Type.Union([Type.String(), Type.Null()]),
});
export type ChatExecutionSettings = Static<typeof ChatExecutionSettingsSchema>;

/**
 * The target sits under `target` so a commit can replace it whole: a draft cannot turn one variant of a root union
 * into another.
 */
export const ExecutionTargetDoc = defineDoc<ExecutionTargetState>({
  kind: 'app.execution-target', version: 2, scope: 'conversation',
  history: 'latest', fork: 'initial', checkpointWhen: () => true, initial: () => ({ target: { kind: 'local' } }),
});

/**
 * Where a local chat's working directory may be: the phone's sandbox root, which every directory lies inside and
 * which stands for an unset one; `null` on a host whose chats run in real folders (the Mac), where an unset
 * directory is the chat's own folder and any absolute path may be chosen.
 */
export type LocalRoot = string | null;
export const DEFAULT_LOCAL_ROOT = '/workspace';

export function executionSettings(state?: Readonly<ExecutionTargetState> | null,
  agent?: Pick<AgentState, 'cwd'> | null, localRoot: LocalRoot = DEFAULT_LOCAL_ROOT): ChatExecutionSettings {
  const target = state?.target;
  if (target?.kind === 'ssh') return { target: { kind: 'ssh', machineId: target.machineId }, cwd: agent?.cwd ?? null };
  return { target: { kind: 'local' }, cwd: agent?.cwd ?? localRoot };
}

export function sameExecution(left: ChatExecutionSettings, right: ChatExecutionSettings): boolean {
  return left.cwd === right.cwd && left.target.kind === right.target.kind &&
    (left.target.kind !== 'ssh' || (right.target.kind === 'ssh' && left.target.machineId === right.target.machineId));
}

export function validateExecution(settings: ChatExecutionSettings, localRoot: LocalRoot = DEFAULT_LOCAL_ROOT): void {
  if (settings.target.kind !== 'local' && (settings.target.kind !== 'ssh' || !settings.target.machineId?.trim())) {
    throw new Error('Choose an execution environment.');
  }
  if (settings.cwd === null) {
    if (settings.target.kind === 'local' && localRoot !== null) {
      throw new Error(`Enter a working directory inside ${localRoot}.`);
    }
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
  const normalized = `/${parts.join('/')}`;
  if (settings.target.kind === 'local' && localRoot !== null && normalized !== localRoot
      && !normalized.startsWith(`${localRoot}/`)) {
    throw new Error(`The local working directory must be inside ${localRoot}.`);
  }
}
