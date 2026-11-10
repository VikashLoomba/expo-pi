import { untilAborted, type Self, type Writable } from '@earendil-works/chord';

import type { MacPrincipal } from '../contract';

/** One of the app's stores, by the part a mirror needs: being told of its changes. */
interface Store {
  subscribe(listener: () => void): () => void;
}

/**
 * What a window's object shows of the stores `index.ts` makes outside Chord, which its factory closes over (chord
 * `docs/design.md` §18, start data): read as the factory runs, since the stores exist by then, and again at each
 * change of one while the object is live (§14, "set up, wait for the end, clean up"). A state member is a derive over
 * the value (§12), so its change goes out as a diff, and the members read from one value change in one message.
 */
export function mirror<T>(self: Self<MacPrincipal>, stores: readonly Store[], read: () => T): Writable<T> {
  const shown = self.writable(read());
  self.onLive(async (ctx) => {
    const publish = () => shown.set(read());
    const stops = stores.map((store) => store.subscribe(publish));
    // What changed between the factory's read and the object going live.
    publish();
    try {
      await untilAborted(ctx);
    } finally {
      for (const stop of stops) stop();
    }
  });
  return shown;
}

/** A method without a result answers `null`, its wire form (chord `docs/design.md` §5, "Methods"). */
export const done = async (work: unknown): Promise<null> => {
  await work;
  return null;
};
