import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../ui/button';
import { Marker, MarkerContent } from '../ui/marker';
import { Spinner } from '../ui/spinner';
import { useThreadSource } from './thread-source';

/**
 * Transcript this window has not loaded, as pi-durable's `ConversationTranscript` marks it: "load earlier" above the
 * oldest entry held, "load more" where entries were missed. It loads once it scrolls into view, as the transcript's
 * README has a client load such a row; a failure offers a retry.
 */
export function HistoryRow({ history }: { history: NonNullable<ChatMessage['history']> }) {
  const source = useThreadSource();
  const row = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = row.current;
    if (element === null) return;
    // The viewport clips the thread, so a row the virtualizer renders above or below it does not count as in view.
    const observer = new IntersectionObserver(([entry]) => setVisible(entry?.isIntersecting ?? false));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const after = history.kind === 'gap' ? history.after : undefined;
  const upTo = history.kind === 'gap' ? history.upTo : undefined;
  useEffect(() => {
    if (!visible) return;
    let current = true;
    const load = after === undefined || upTo === undefined ? source.loadEarlier(BACKGROUND_CONTEXT)
      : source.fillGap({ after, upTo }, BACKGROUND_CONTEXT);
    load.catch(() => {
      if (current) setFailed(true);
    });
    return () => {
      current = false;
    };
  }, [after, attempt, source, upTo, visible]);
  const what = history.kind === 'earlier' ? 'earlier messages' : 'these messages';
  const retry = () => {
    setFailed(false);
    setAttempt((count) => count + 1);
  };
  return (
    <div ref={row}>
      <Marker variant="separator">
        <MarkerContent>
          {failed ? (
            <>
              Couldn’t load {what}.
              <Button variant="link" size="sm" onClick={retry}>Try Again</Button>
            </>
          ) : (
            <><Spinner /> Loading {what}…</>
          )}
        </MarkerContent>
      </Marker>
    </div>
  );
}
