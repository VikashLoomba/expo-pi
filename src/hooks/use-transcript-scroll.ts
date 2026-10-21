import { useRef, useState } from 'react';
import type { FlatList, LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import type { ChatMessage } from '@/chat/types';

/** Offers a jump to the newest message once the reader is well above it. */
export function useTranscriptScroll() {
  const list = useRef<FlatList<ChatMessage>>(null);
  const metrics = useRef({ height: 0, viewport: 0, offset: 0 });
  const [showScrollDown, setShowScrollDown] = useState(false);
  const update = () => {
    const { height, viewport, offset } = metrics.current;
    setShowScrollDown(height - viewport - offset > 120);
  };
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    metrics.current.offset = event.nativeEvent.contentOffset.y;
    update();
  };
  const onContentSizeChange = (_width: number, height: number) => {
    metrics.current.height = height;
    update();
  };
  const onLayout = (event: LayoutChangeEvent) => {
    metrics.current.viewport = event.nativeEvent.layout.height;
    update();
  };
  // FlatList.scrollToEnd estimates unmeasured rows; the measured content size lands on the real end.
  const scrollToLatest = () => {
    const { height, viewport } = metrics.current;
    list.current?.scrollToOffset({ offset: Math.max(0, height - viewport), animated: true });
  };

  return { list, onScroll, onContentSizeChange, onLayout, scrollToLatest, showScrollDown };
}
