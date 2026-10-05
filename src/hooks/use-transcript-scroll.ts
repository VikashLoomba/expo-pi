import { useCallback, useEffect, useState } from 'react';
import type { FlatList, LayoutChangeEvent } from 'react-native';
import {
  cancelAnimation, Easing, ReduceMotion, runOnJS, runOnUI, scrollTo,
  useAnimatedReaction, useAnimatedRef, useAnimatedScrollHandler, useSharedValue, withTiming,
} from 'react-native-reanimated';

import type { ChatMessage } from '@/chat/types';

/** Keep following new output until the reader takes control of the transcript. */
export function useTranscriptScroll() {
  const list = useAnimatedRef<FlatList<ChatMessage>>();
  const height = useSharedValue(0);
  const viewport = useSharedValue(0);
  const offset = useSharedValue(0);
  const position = useSharedValue(0);
  const following = useSharedValue(true);
  const dragging = useSharedValue(false);
  const momentum = useSharedValue(false);
  const initialized = useSharedValue(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  useEffect(() => () => cancelAnimation(position), [position]);

  // FlatList.scrollToEnd estimates unmeasured rows. Use the scroll view's actual
  // content size instead, and retarget one UI-thread animation as text grows.
  useAnimatedReaction(
    () => ({ bottom: Math.max(0, height.get() - viewport.get()), ready: viewport.get() > 0 && height.get() > 0, follow: following.get() }),
    (current, previous) => {
      if (!current.ready || !current.follow || dragging.get() || momentum.get()) return;
      if (!initialized.get()) {
        initialized.set(true);
        position.set(current.bottom);
        scrollTo(list, 0, current.bottom, false);
      } else if (!previous?.follow || current.bottom !== previous.bottom) {
        position.set(withTiming(current.bottom, { duration: 160, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.System }));
      }
    },
  );
  useAnimatedReaction(() => position.get(), (value) => {
    if (initialized.get() && following.get() && !dragging.get() && !momentum.get()) scrollTo(list, 0, value, false);
  });
  useAnimatedReaction(
    () => !following.get() && Math.max(0, height.get() - viewport.get()) - offset.get() > 120,
    (visible, previous) => { if (visible !== previous) runOnJS(setShowScrollDown)(visible); },
  );

  const onScroll = useAnimatedScrollHandler({
    onScroll(event) {
      offset.set(event.contentOffset.y);
      if (!following.get()) position.set(event.contentOffset.y);
    },
    onBeginDrag(event) {
      // Stop immediately, even if a size-change animation is already in flight.
      following.set(false);
      dragging.set(true);
      cancelAnimation(position);
      position.set(event.contentOffset.y);
    },
    onEndDrag(event) {
      dragging.set(false);
      const distance = Math.max(0, height.get() - viewport.get()) - event.contentOffset.y;
      if (Math.abs(event.velocity?.y ?? 0) < 0.1 && distance <= 48) following.set(true);
    },
    onMomentumBegin() {
      momentum.set(true);
      following.set(false);
      cancelAnimation(position);
    },
    onMomentumEnd(event) {
      // Fabric also sends this after programmatic scrollTo(..., false). Only
      // a momentum sequence started by the reader may change follow intent.
      if (!momentum.get()) return;
      momentum.set(false);
      position.set(event.contentOffset.y);
      following.set(Math.max(0, height.get() - viewport.get()) - event.contentOffset.y <= 48);
    },
  });
  const onContentSizeChange = useCallback((_width: number, value: number) => { height.set(value); }, [height]);
  const onLayout = useCallback((event: LayoutChangeEvent) => { viewport.set(event.nativeEvent.layout.height); }, [viewport]);
  const scrollToLatest = useCallback(() => {
    runOnUI(() => {
      'worklet';
      dragging.set(false);
      momentum.set(false);
      position.set(offset.get());
      following.set(true);
      position.set(withTiming(Math.max(0, height.get() - viewport.get()), {
        duration: 160, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.System,
      }));
    })();
  }, [dragging, following, height, momentum, offset, position, viewport]);

  return { list, onScroll, onContentSizeChange, onLayout, scrollToLatest, showScrollDown };
}
