import assert from 'node:assert/strict';

/**
 * Subscribe to a chat the way the chat screen does and wait for its committed state.
 * `conversation` stays current while the watch is open; call `close()` to detach.
 */
export async function watchChat(service, id, { transcript = true } = {}) {
  const view = service.chat(id, { transcript });
  const close = view.subscribe(() => {});
  const deadline = Date.now() + 3_000;
  while (view.getSnapshot().status === 'loading') {
    assert.ok(Date.now() < deadline, 'the chat view loads');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return {
    get status() { return view.getSnapshot().status; },
    get conversation() { return view.getSnapshot().conversation; },
    close,
  };
}

/** The chat as a newly opened chat screen shows it. */
export async function readChat(service, id) {
  const chat = await watchChat(service, id);
  try { return chat.conversation; }
  finally { chat.close(); }
}
