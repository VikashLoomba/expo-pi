import assert from 'node:assert/strict';
import { createAssistantMessageEventStream, createModels, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';

function assistant(model, content = [], stopReason = 'stop', errorMessage) {
  return {
    role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(), ...(errorMessage ? { errorMessage } : {}),
  };
}

export function controlledReply({ model, options }) {
  const stream = createAssistantMessageEventStream();
  const message = assistant(model);
  stream.push({ type: 'start', partial: structuredClone(message) });
  const abort = () => {
    message.stopReason = 'aborted';
    message.errorMessage = 'Request aborted';
    stream.push({ type: 'error', reason: 'aborted', error: structuredClone(message) });
  };
  options.signal.addEventListener('abort', abort, { once: true });
  return {
    stream,
    signal: options.signal,
    text(delta) {
      if (!message.content.length) {
        message.content.push({ type: 'text', text: '' });
        stream.push({ type: 'text_start', contentIndex: 0, partial: structuredClone(message) });
      }
      message.content[0].text += delta;
      stream.push({ type: 'text_delta', contentIndex: 0, delta, partial: structuredClone(message) });
    },
    finish({ tool, error } = {}) {
      options.signal.removeEventListener('abort', abort);
      if (tool) {
        const contentIndex = message.content.length;
        message.content.push({ type: 'toolCall', id: 'addition-1', name: 'add_numbers', arguments: {} });
        stream.push({ type: 'toolcall_start', contentIndex, partial: structuredClone(message) });
        message.content[contentIndex].arguments = tool;
        stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(tool), partial: structuredClone(message) });
        stream.push({ type: 'toolcall_end', contentIndex, toolCall: message.content[contentIndex], partial: structuredClone(message) });
      }
      message.stopReason = error ? 'error' : tool ? 'toolUse' : 'stop';
      if (error) {
        message.errorMessage = error;
        stream.push({ type: 'error', reason: 'error', error: structuredClone(message) });
      } else {
        stream.push({ type: 'done', reason: message.stopReason, message: structuredClone(message) });
      }
    },
  };
}

export function scriptedModels(script, { authenticated = true } = {}) {
  const auth = { authenticated };
  const requests = [];
  const models = createModels({
    credentials: new InMemoryCredentialStore(),
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const provider = anthropicProvider();
  const dispatch = (model, context, options) => {
    const request = { model, context: structuredClone(context), options };
    requests.push(request);
    const step = script[requests.length - 1];
    assert.ok(step, 'no unexpected extra model request may be sent');
    if (typeof step === 'function') return step(request);
    const response = controlledReply(request);
    for (const chunk of step.chunks ?? []) response.text(chunk);
    response.finish(step);
    return response.stream;
  };
  models.setProvider({
    ...provider,
    auth: { apiKey: {
      name: 'Test credential',
      check: async () => auth.authenticated ? { type: 'api_key' } : undefined,
      resolve: async () => auth.authenticated ? { auth: { apiKey: 'test-only-key' } } : undefined,
    } },
    stream: dispatch, streamSimple: dispatch,
  });
  return { models, requests, auth };
}
