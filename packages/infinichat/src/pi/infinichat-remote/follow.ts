import type { Link } from '@earendil-works/chord';
import type { Context } from '@earendil-works/chord/context';
import type { NativeWatchable, Watchable } from '@earendil-works/chord/watch';

/**
 * `link` as a host takes it, whose close the caller hears too. A link end keeps one close listener, and the host sets
 * its own when it takes the link (chord `src/link/link.ts`, `LinkEnd.onClose`; `src/link/channel.ts`), so a listener
 * the caller set on the link itself would be replaced. `closed` runs once, before the host's.
 */
export function heard(link: Link, closed: () => void): Link {
  let ended = false;
  let hostListener: (() => void) | undefined;
  link.onClose(() => {
    ended = true;
    closed();
    hostListener?.();
  });
  return {
    send: (message) => link.send(message),
    onMessage: (listener) => link.onMessage(listener),
    close: () => link.close(),
    // As a link end does: a listener set after the close hears of it at once.
    onClose: (listener) => {
      if (ended) listener();
      else hostListener = listener;
    },
  };
}

/**
 * Calls `changed` at each new value or failure of `source`, a reference's member or its state, until the returned
 * function runs or `context` is aborted (chord `docs/design.md` §11, "Watchables"). A reference keeps its members'
 * watches across its links and its object's restarts, so one follow lasts as long as its hold (§7).
 */
export function follow(source: Watchable<unknown> | NativeWatchable<unknown>, changed: () => void,
  context: Context): () => void {
  let stopped = false;
  let stop = () => {
    stopped = true;
  };
  source.watch(context).then((watch) => {
    if (stopped) {
      void watch.stop();
      return;
    }
    stop = () => {
      void watch.stop();
    };
    watch.start(async () => changed());
    // What changed between the caller's read and this watch.
    changed();
  }, () => {});
  return () => stop();
}
