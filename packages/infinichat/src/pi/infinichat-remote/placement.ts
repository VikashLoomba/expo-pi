import type { ConversationState, InfiniChatClient } from './contract';
import type { InstallStage } from './dialer';
import { cancellable, moveError, type MoveStatus } from './move-status';

/** A connection as either app reports it: `RemoteInfiniChat`'s own, or the Mac's contract cell of it. */
export interface PlacementLink {
  status: 'connecting' | 'connected' | 'failed';
  stage?: InstallStage;
  error?: string;
}

/**
 * Where InfiniChat's conversation is, as the apps' screens show it: one answer from the sources each app has, so the
 * iPhone and the Mac offer and report the same things. Each app words the result for itself.
 */
export type Placement =
  /** On this device. */
  | { at: 'here' }
  /** On the machine `id`, reached over `link`. */
  | { at: 'machine'; id: string; link: PlacementLink | undefined }
  /** Between two sides; `stage` is what the target's install is doing while the move connects. */
  | { at: 'moving'; move: MoveStatus; stage: InstallStage | undefined }
  /** The machine shown doesn't hold it: it handed it to `holder`, or never had it. */
  | { at: 'elsewhere'; id: string; holder: InfiniChatClient | undefined; link: PlacementLink | undefined }
  /** On a machine this app has no credentials for. */
  | { at: 'removed'; id: string; link: PlacementLink | undefined };

/**
 * `machineId` is the machine the conversation lives on as this app knows it, null for this device; `link` the
 * connection to it, or to a move's target while the move connects; `held` what the machine shown says of the
 * conversation, where the app reads it; `removed` that this app has no credentials for `machineId`. A move comes
 * first, so its failure and its Cancel always show.
 */
export function placement(input: {
  machineId: string | null; move: MoveStatus | undefined; link: PlacementLink | undefined;
  held?: ConversationState; removed?: boolean;
}): Placement {
  const { machineId, move, link, held } = input;
  if (move !== undefined) return { at: 'moving', move, stage: link?.status === 'connecting' ? link.stage : undefined };
  if (machineId === null) return { at: 'here' };
  if (input.removed) return { at: 'removed', id: machineId, link };
  if (held !== undefined && !held.active) return { at: 'elsewhere', id: machineId, holder: held.heldBy, link };
  return { at: 'machine', id: machineId, link };
}

/**
 * The machine menu's checkmark: where the conversation is going during a move, back where it was during a Cancel,
 * and where it lives otherwise; null for this device.
 */
export function chosenMachine(place: Placement): string | null {
  if (place.at === 'here') return null;
  if (place.at !== 'moving') return place.id;
  const { move } = place;
  const forward = move.phase === 'moving' || move.phase === 'failed';
  return (move.to === 'machine') === forward ? move.machineId : move.from ?? null;
}

/** What stands in the way, and what Try Again does about it; a removed machine has nothing to try again. */
export interface PlacementError { message: string; retry?: 'move' | 'link' }

/** What a screen offers and reports at a placement, the same on both apps. */
export function placementOffers(place: Placement): {
  /** The side shown holds the conversation and no move does: it takes a message, and continues a run that failed. */
  available: boolean;
  /** Cancel Move. */
  cancel: boolean;
  error: PlacementError | undefined;
} {
  if (place.at === 'moving') {
    // A stopped move comes before a failed connection: trying the move again connects again.
    const stopped = moveError(place.move);
    const error: PlacementError | undefined = stopped === undefined ? undefined : { message: stopped, retry: 'move' };
    return { available: false, cancel: cancellable(place.move), error };
  }
  const link = place.at === 'here' ? undefined : place.link;
  const failed = link?.status === 'failed' ? link.error : undefined;
  const error: PlacementError | undefined = failed === undefined ? undefined
    : place.at === 'removed' ? { message: failed } : { message: failed, retry: 'link' };
  return { available: place.at !== 'elsewhere', cancel: false, error };
}
