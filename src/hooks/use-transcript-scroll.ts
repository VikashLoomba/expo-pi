import { useRef, useState } from 'react';
import type { KeyboardChatScrollViewRef } from 'react-native-keyboard-controller';

/** Offers a jump to the newest message once the reader leaves it. */
export function useTranscriptScroll() {
  const scrollRef = useRef<KeyboardChatScrollViewRef | null>(null);
  const pinned = useRef(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const onEndVisible = (visible: boolean) => { setShowScrollDown(!visible); };
  const onScrollBeginDrag = () => { pinned.current = false; };
  // Rows that never rendered are estimated, so the end moves once they render; stay on it until the reader drags.
  const onContentSizeChange = () => {
    if (pinned.current) scrollRef.current?.scrollToEnd({ animated: false });
  };
  const scrollToLatest = () => {
    pinned.current = true;
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  return { scrollRef, onEndVisible, onScrollBeginDrag, onContentSizeChange, scrollToLatest, showScrollDown };
}
