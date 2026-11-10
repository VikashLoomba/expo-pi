import type { Copied } from './transfer';

export type MoveStep = 'connecting' | 'closing' | 'copying' | 'opening';

/** What every phase of a move says: the machine, the direction, and the step it reached. */
export type MoveBase = {
  machineId: string;
  /** `phone` is this device, as in the home record. */
  to: 'machine' | 'phone';
  /** The machine a move straight to `machineId` comes from; this device otherwise. */
  from?: string;
  step: MoveStep;
};

/**
 * A move between this device and a machine, as `InfiniChatMoves` reports it, by phase: `moving` while it runs,
 * `failed` once a failure stopped it, `undoing` while a Cancel puts the conversation back, and `undo-failed` once a
 * failure stopped that. A stopped move keeps its step, and the home record its phase, until it is tried again or
 * cancelled.
 */
export type MoveStatus = MoveBase & (
  | { phase: 'moving'; copied?: Copied }
  | { phase: 'failed'; error: string }
  | { phase: 'undoing' }
  | { phase: 'undo-failed'; error: string }
);

/** Cancel can still put the conversation back where it was: before the opening step, and after a failure. */
export const cancellable = (move: MoveStatus): boolean =>
  move.phase !== 'undoing' && !(move.phase === 'moving' && move.step === 'opening');

/** Why a move stopped, forward or while it was being cancelled; undefined while it runs. */
export const moveError = (move: MoveStatus | undefined): string | undefined =>
  move?.phase === 'failed' || move?.phase === 'undo-failed' ? move.error : undefined;
