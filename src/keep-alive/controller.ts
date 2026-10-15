import type { AttachedReplicatedState } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { Harness, TaskGraph, TaskGraphNode } from '@earendil-works/pi-durable';
import * as Location from 'expo-location';
import type { LiveActivity } from 'expo-widgets';

import { AgentTask } from '../pi/infinichat/agents';
import { BuildNode } from '../pi/infinichat/summary';
import AgentActivity, { type AgentActivityProps } from './agent-activity';
import { KEEP_ALIVE_LOCATION_TASK } from './location-task';
import type { KeepAliveSettings } from './settings';

const context = BACKGROUND_CONTEXT;

const propsFor = (activeChats: number, status: string): AgentActivityProps => ({ activeChats, status });

/** The chat a live task is work for, keyed within its Harness, or undefined when the task is not work. */
export type ChatOfTask = (task: TaskGraphNode) => string | undefined;

/** A chat's work is its conversation's foreground tasks; background tasks never keep it busy. */
export const chatTasks: ChatOfTask = (task) => task.background ? undefined : String(task.conversationId);

const INFINICHAT = 'infinichat';
const infiniChatWork = new Set([BuildNode.definition.name, AgentTask.definition.name]);

/**
 * InfiniChat is one chat. Its turns are foreground tasks, and its summary builds and private agents are work although
 * they are background tasks; its coordinator is always live, so it never is.
 */
export const infiniChatTasks: ChatOfTask = (task) =>
  !task.background || infiniChatWork.has(task.kind) ? INFINICHAT : undefined;

type Source = {
  harness: Harness;
  chatOf: ChatOfTask;
  graph?: AttachedReplicatedState<TaskGraph>;
  unsubscribe: () => void;
};

/**
 * Keeps agent work running while the phone is locked, as Termius does: while any observed Harness has live work,
 * the app holds a background location stream (which keeps the process running; the locations are unused) and a
 * Live Activity showing progress. Both end when the work does. Everything is inert unless the user opted in;
 * the setting applies at the next work change. One controller observes every Harness, so there is one stream and
 * one Live Activity.
 */
export class KeepAliveController {
  private readonly sources = new Set<Source>();
  private unsubscribeSettings = () => {};
  private queue: Promise<void> = Promise.resolve();
  private activity?: LiveActivity<AgentActivityProps>;
  private locating = false;
  private closed = false;

  constructor(private readonly settings: KeepAliveSettings) {}

  start(): void {
    // A Live Activity can outlive the process that started it; adopt any running one, and let the first sync
    // after a Harness attaches decide whether it gets updated or ended.
    const [existing] = AgentActivity.getInstances();
    this.activity = existing;
    this.unsubscribeSettings = this.settings.subscribe(this.schedule);
  }

  /**
   * Counts a Harness's live tasks as `chatOf` says until the returned function detaches it. The Harness's owner
   * detaches it once the Harness is closed.
   */
  observe(harness: Harness, chatOf: ChatOfTask): () => void {
    const source: Source = { harness, chatOf, unsubscribe: () => {} };
    this.sources.add(source);
    // A Harness that closes before its graph attaches leaves nothing to count.
    this.attach(source).catch(() => {});
    return () => {
      if (!this.sources.delete(source)) return;
      source.unsubscribe();
      source.graph?.dispose();
      this.schedule();
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribeSettings();
    for (const source of this.sources) {
      source.unsubscribe();
      source.graph?.dispose();
    }
    this.sources.clear();
    await this.queue;
    // Nothing here touches a Harness, so a close after the Harnesses' own is safe.
    await this.disengage(0);
  }

  private async attach(source: Source) {
    const graph = await source.harness.taskGraph(context);
    if (this.closed || !this.sources.has(source)) {
      graph.dispose();
      return;
    }
    source.graph = graph;
    source.unsubscribe = graph.subscribe(this.schedule);
    this.schedule();
  }

  private readonly schedule = () => {
    if (this.closed) return;
    this.queue = this.queue.then(() => this.sync()).catch(() => {});
  };

  /** Chats with live work across the observed Harnesses. */
  private async busyChats(): Promise<number> {
    let busy = 0;
    for (const source of [...this.sources]) {
      const graph = source.graph?.value;
      if (!graph) continue;
      // Tasks blocked by a missing definition never run again; keeping the phone alive for them would never stop.
      const inspection = await source.harness.inspect(context);
      const blocked = new Set(inspection.tasks.flatMap((task) =>
        task.state.kind === 'blocked' ? [String(task.record.id)] : []));
      const chats = new Set<string>();
      for (const task of Object.values(graph.tasks)) {
        if (blocked.has(String(task.id))) continue;
        const chat = source.chatOf(task);
        if (chat !== undefined) chats.add(chat);
      }
      busy += chats.size;
    }
    return busy;
  }

  private async sync() {
    if (this.closed) return;
    const busy = await this.busyChats();
    if (this.closed) return;
    if (busy > 0 && this.settings.getSnapshot()) await this.engage(busy);
    else await this.disengage(busy);
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
