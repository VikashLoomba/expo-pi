import type { ChatMessage } from '@pi-agent/infinichat/chat/types';
import type { FlashListRef } from '@shopify/flash-list';
import { useRef, useState } from 'react';

/** Offers a jump to the newest message once the reader leaves it. */
export function useTranscriptScroll() {
  const listRef = useRef<FlashListRef<ChatMessage>>(null);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const onEndVisible = (visible: boolean) => { setShowScrollDown(!visible); };
  // FlashList's autoscroll keeps following from the end it lands on.
  const scrollToLatest = () => { void listRef.current?.scrollToEnd({ animated: true }); };

  return { listRef, onEndVisible, scrollToLatest, showScrollDown };
}
