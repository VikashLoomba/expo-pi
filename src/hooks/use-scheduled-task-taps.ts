import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';

import { opensInfiniChat } from '@/pi/infinichat-notifications';

/**
 * Opens InfiniChat when a scheduled task's notification or its "Open" is tapped, at launch or while the app runs, as
 * Expo's notifications guide routes a tap with Expo Router in the root layout. The response is cleared once handled,
 * so a later mount doesn't open InfiniChat again.
 */
export function useScheduledTaskTaps() {
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse) => {
      if (!opensInfiniChat(response)) return;
      // `dismissTo` closes a sheet over the tabs, which `navigate` would push the tabs again above; `navigate` selects
      // InfiniChat's tab, which `dismissTo` leaves as it is when no sheet is open (expo-router 58.0.25).
      router.dismissTo('/');
      router.navigate('/');
      Notifications.clearLastNotificationResponse();
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) open(last);
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, []);
}
