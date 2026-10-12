import * as TaskManager from 'expo-task-manager';

/** The task name of the background location stream that keeps the process alive while agent work runs. */
export const KEEP_ALIVE_LOCATION_TASK = 'pi-keep-alive-location';

/**
 * Defined at top level, as expo-location's background updates require. The stream's only job is to keep the
 * process alive; the locations themselves are not used for anything and are never stored or sent anywhere.
 */
TaskManager.defineTask(KEEP_ALIVE_LOCATION_TASK, async () => {});
