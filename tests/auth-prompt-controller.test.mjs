import assert from 'node:assert/strict';
import test from 'node:test';

import { AuthPromptController } from '../src/chat/auth-prompt-controller.ts';

test('manual callback answers are returned to Pi without entering shared state', async () => {
  const prompts = new AuthPromptController();
  const history = [];
  prompts.subscribe(() => history.push(prompts.getSnapshot()));
  const answer = prompts.prompt({ type: 'manual_code', message: 'Paste callback' }, new AbortController().signal);
  const id = prompts.getSnapshot().id;
  const callback = 'http://127.0.0.1:1455/auth/callback?code=synthetic-secret&state=state';
  assert.equal(prompts.submit(id, `  ${callback}  `), true);
  assert.equal(await answer, `  ${callback}  `, 'Pi owns parsing; the bridge preserves the entered answer');
  assert.equal(prompts.getSnapshot(), null);
  assert.doesNotMatch(JSON.stringify(history), /synthetic-secret/);
  assert.equal(prompts.submit(id, callback), false, 'a late double submission cannot settle another prompt');
});

test('cancelling a login rejects and clears the pending callback prompt', async () => {
  const prompts = new AuthPromptController();
  const flow = new AbortController();
  const answer = prompts.prompt({ type: 'manual_code', message: 'Paste callback' }, flow.signal);
  const rejection = assert.rejects(answer, /Cancelled by user/);
  flow.abort(new Error('Cancelled by user'));
  await rejection;
  assert.equal(prompts.getSnapshot(), null);
});

test('Pi can cancel a manual prompt when automatic callback wins without cancelling the flow', async () => {
  const prompts = new AuthPromptController();
  const flow = new AbortController();
  const step = new AbortController();
  const answer = prompts.prompt({ type: 'manual_code', message: 'Paste callback', signal: step.signal }, flow.signal);
  const oldId = prompts.getSnapshot().id;
  const rejection = assert.rejects(answer, /Automatic callback received/);
  step.abort(new Error('Automatic callback received'));
  await rejection;
  assert.equal(flow.signal.aborted, false);
  const next = prompts.prompt({ type: 'text', message: 'Next step' }, flow.signal);
  assert.equal(prompts.submit(oldId, 'stale answer'), false);
  prompts.submit(prompts.getSnapshot().id, 'current answer');
  assert.equal(await next, 'current answer');
});

test('select prompts accept only an offered option and text prompts reject empty input', async () => {
  const prompts = new AuthPromptController();
  const answer = prompts.prompt({ type: 'select', message: 'Method', options: [{ id: 'browser', label: 'Browser' }] }, new AbortController().signal);
  const id = prompts.getSnapshot().id;
  assert.equal(prompts.submit(id, 'invented'), false);
  assert.equal(prompts.submit(id, '  '), false);
  assert.equal(prompts.submit(id, 'browser'), true);
  assert.equal(await answer, 'browser');
});

test('route teardown rejects a prompt and supports a later fresh login', async () => {
  const prompts = new AuthPromptController();
  const answer = prompts.prompt({ type: 'secret', message: 'Secret' }, new AbortController().signal);
  const rejection = assert.rejects(answer, { name: 'AbortError' });
  prompts.cancel();
  await rejection;
  assert.equal(prompts.getSnapshot(), null);
  const next = prompts.prompt({ type: 'text', message: 'New sign-in' }, new AbortController().signal);
  prompts.submit(prompts.getSnapshot().id, 'answer');
  assert.equal(await next, 'answer');
});

test('concurrent prompts and previously aborted steps do not replace the active prompt', async () => {
  const prompts = new AuthPromptController();
  const first = prompts.prompt({ type: 'text', message: 'First' }, new AbortController().signal);
  const pending = prompts.getSnapshot();
  await assert.rejects(prompts.prompt({ type: 'text', message: 'Second' }, new AbortController().signal), /already open/);
  assert.throws(() => prompts.prompt({ type: 'text', message: 'Aborted', signal: AbortSignal.abort(new Error('aborted')) }, new AbortController().signal), /aborted/);
  assert.equal(prompts.getSnapshot(), pending);
  prompts.submit(pending.id, 'first');
  assert.equal(await first, 'first');
});
