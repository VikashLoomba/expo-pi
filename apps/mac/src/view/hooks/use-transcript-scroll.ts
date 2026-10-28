import { useCallback, useLayoutEffect, useRef, useState } from 'react';

/** How far from the end the transcript still counts as at the end, and follows what arrives there. */
const NEAR_END = 80;

/**
 * The scroll position of a message list that renders its scroller for its whole lifetime, as FlashList's chat setting
 * keeps it on the phone: it opens on the newest message; near the end it follows new rows, streaming text and images
 * that load; further up the reader's position holds and a jump to the latest message is offered.
 */
export function useTranscriptScroll() {
  const scroller = useRef<HTMLDivElement>(null);
  const [atEnd, setAtEnd] = useState(true);
  const nearEnd = useRef(true);
  const scrollToLatest = useCallback(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);
  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    nearEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_END;
    setAtEnd(nearEnd.current);
  }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    const observer = new ResizeObserver(() => {
      if (nearEnd.current) element.scrollTop = element.scrollHeight;
    });
    for (const content of element.children) observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return { scroller, atEnd, scrollToLatest, onScroll };
}
