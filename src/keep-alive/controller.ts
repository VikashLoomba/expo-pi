import type { AttachedReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ConversationId, Harness, TaskGraph } from '@earendil-works/pi-durable';
import * as Location from 'expo-location';
import type { LiveActivity } from 'expo-widgets';

import AgentActivity, { type AgentActivityProps } from './agent-activity';
import { KEEP_ALIVE_LOCATION_TASK } from './location-task';
import type { KeepAliveSettings } from './settings';

const context = BACKGROUND_CONTEXT;

const propsFor = (activeChats: number, status: string): AgentActivityProps => ({ activeChats, status });

/**
 * Keeps agent work running while the phone is locked, as Termius does: while any conversation has live work,
 * the app holds a background location stream (which keeps the process running; the locations are unused) and a
 * Live Activity showing progress. Both end when the work does. Everything is inert unless the user opted in;
 * the setting applies at the next work change.
 */
export class KeepAliveController {
  private graph?: AttachedReplicatedState<TaskGraph>;
  private unsubscribeGraph = () => {};
  private unsubscribeSettings = () => {};
  private queue: Promise<void> = Promise.resolve();
  private activity?: LiveActivity<AgentActivityProps>;
  private locating = false;
  private closed = false;

  constructor(private readonly harness: Harness, private readonly settings: KeepAliveSettings) {}

  start(): void {
    void this.attach();
    this.unsubscribeSettings = this.settings.subscribe(this.schedule);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeGraph();
    this.unsubscribeSettings();
    this.graph?.dispose();
    this.graph = undefined;
    await this.queue;
    // Nothing here touches the Harness, so a close after the Harness's own is safe.
    await this.disengage(0);
  }

  private async attach() {
    const graph = await this.harness.taskGraph(context);
    if (this.closed) {
      graph.dispose();
      return;
    }
    this.graph = graph;
    this.unsubscribeGraph = graph.subscribe(this.schedule);
    // A Live Activity can outlive the process that started it; adopt any running one, then let sync decide
    // whether it gets updated or ended.
    const [existing] = AgentActivity.getInstances();
    this.activity = existing;
    this.schedule();
  }

  private readonly schedule = () => {
    if (this.closed) return;
    this.queue = this.queue.then(() => this.sync()).catch(() => {});
  };

  /** Conversations with live work: the graph's live tasks, minus background tasks and blocked ones. */
  private async busyConversations(): Promise<ConversationId[]> {
    const graph = this.graph?.value;
    if (!graph) return [];
    // Tasks blocked by a missing definition never run again; keeping the phone alive for them would never stop.
    const inspection = await this.harness.inspect(context);
    const blocked = new Set(inspection.tasks.flatMap((task) =>
      task.state.kind === 'blocked' ? [String(task.record.id)] : []));
    const chats = new Set<ConversationId>();
    for (const node of Object.values(graph.tasks)) {
      if (node.background || blocked.has(String(node.id))) continue;
      chats.add(node.conversationId);
    }
    return [...chats];
  }

  private async sync() {
    if (this.closed) return;
    const busy = await this.busyConversations();
    if (this.closed) return;
    if (busy.length > 0 && this.settings.getSnapshot()) await this.engage(busy.length);
    else await this.disengage(busy.length);
  }

  private async engage(activeChats: number) {
    const props = propsFor(activeChats, 'Pi is working');
    try {
      if (this.activity === undefined) this.activity = AgentActivity.start(props, 'piagent://');
      else await this.activity.update(props);
    } catch { /* Live Activities can be off system-wide; keep-alive does not depend on one. */ }
    if (this.locating) return;
    const permission = await Location.getBackgroundPermissionsAsync();
    // The Account screen asks for this when the setting is switched on; a revoked permission just stays inert.
    if (permission.status !== 'granted') return;
    await Location.startLocationUpdatesAsync(KEEP_ALIVE_LOCATION_TASK, {
      // Only keeping the process alive: the lowest power source, a wide interval, and the system indicator on.
      accuracy: Location.Accuracy.Lowest,
      distanceInterval: 3000,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: true,
      activityType: Location.ActivityType.Other,
    });
    this.locating = true;
  }

  private async disengage(activeChats: number) {
    if (this.locating) {
      this.locating = false;
      await Location.stopLocationUpdatesAsync(KEEP_ALIVE_LOCATION_TASK).catch(() => {});
    }
    if (this.activity !== undefined) {
      const activity = this.activity;
      this.activity = undefined;
      await activity.end('immediate',
        activeChats === 0 ? propsFor(0, 'Work finished') : propsFor(activeChats, 'Pi is working')).catch(() => {});
    }
  }
}
