import type { Ctx, Host } from '@earendil-works/chord';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';

import {
  ControlsSchema, InfiniChatRemote, MessagesSchema, ScheduledSchema, SnapshotSchema, type InfiniChatPrincipal,
} from '../src/pi/infinichat-remote/contract';
import type { InfiniChatService } from '../src/pi/infinichat-service';

/** A call's context for the core's own waits: the caller cancels the wait, never the work. */
const callContext = (ctx: Ctx<InfiniChatPrincipal>) => withAbortSignal(ctx.signal, BACKGROUND_CONTEXT);

/**
 * Serves the core as InfiniChat's remote object. Its cells mirror the core's view, its latest report and its
 * scheduled tasks; the view's projection rebuilds its arrays on every update, so each write goes out as a diff.
 */
export function serveInfiniChat(host: Host<InfiniChatPrincipal>, core: InfiniChatService) {
  host.serve(InfiniChatRemote, (_input, _principal, self) => {
    const view = core.view();
    const currentSnapshot = () => {
      const { error } = core.getSnapshot();
      return { view: view.getSnapshot(), ...(error === undefined ? {} : { report: error }) };
    };
    const snapshot = self.state('snapshot', SnapshotSchema, { init: currentSnapshot });
    const controls = self.state('controls', ControlsSchema, { init: () => view.getControls() ?? null });
    const messages = self.state('messages', MessagesSchema, { init: () => view.getMessages() });
    const scheduled = self.state('scheduled', ScheduledSchema, { init: () => core.scheduled.getSnapshot() ?? [] });
    const mirror = (_change: unknown, ctx: Ctx<InfiniChatPrincipal>) => {
      snapshot.replace(ctx, currentSnapshot(), { diff: true });
      controls.replace(ctx, view.getControls() ?? null, { diff: true });
      messages.replace(ctx, view.getMessages(), { diff: true });
      scheduled.replace(ctx, core.scheduled.getSnapshot() ?? [], { diff: true });
    };
    // The view attaches once this object follows it and publishes when it has read the conversation, so every cell
    // also catches up on what changed while the object went live.
    self.on('view', view, mirror);
    self.on('report', core, mirror);
    self.on('scheduled', core.scheduled, mirror);
    return {
      variant: 'owner',
      snapshot,
      controls,
      messages,
      scheduled,
      accept: ({ content, requestId }, ctx) => core.accept(content, requestId, callContext(ctx)),
      stop: () => core.stop(),
      updateSettings: ({ main, summary, instructions }, ctx) =>
        core.updateSettings(main, summary, instructions, callContext(ctx)),
      cancelScheduled: ({ id, replacement }, ctx) => core.cancelScheduled(id, replacement, callContext(ctx)),
      dismissError: () => core.dismissError(),
    };
  });
}
