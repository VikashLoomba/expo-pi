import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createExpoSqliteDatabase } from '../../src/pi/storage/expo-sqlite.ts';
import { readChat } from './chat-view.mjs';
import { createNodeSqliteConnection } from './node-sqlite.mjs';
import { nodeWorkspaces } from './node-workspaces.mjs';

/** Deterministic model transport, never evidence of a real provider run. */
export function bashReply(command, args = {}) {
  return toolReply('bash', { command, ...args });
}

export function toolReply(name, args) {
  return toolRound([{ name, arguments: args }]);
}

/** Emit the same protocol messages as a provider, against the actual durable harness. */
export function toolRound(calls) {
  return ({ model }) => {
    const stream = createAssistantMessageEventStream();
    const message = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: calls.map((call, index) => ({ type: 'toolCall', id: call.id ?? `${call.name}-${index}`, ...call })),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'toolUse', timestamp: Date.now(),
    };
    stream.push({ type: 'start', partial: structuredClone(message) });
    stream.push({ type: 'done', reason: 'toolUse', message });
    return stream;
  };
}

/** A chat database and a directory of workspaces, both in one temporary directory. */
export async function integrationDatabase(t, Service) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-bash-integration-'));
  const chatPath = join(directory, 'chats.sqlite');
  const workspaceRoot = join(directory, 'workspaces');
  const workspaces = nodeWorkspaces(workspaceRoot);
  const services = new Set();
  const storageByService = new Map();
  t.after(async () => {
    await Promise.allSettled([...services].map((service) => service.close()));
    await rm(directory, { recursive: true, force: true });
  });
  const openStorage = () => SqliteStorage.open(createExpoSqliteDatabase(createNodeSqliteConnection(chatPath)));
  return {
    directory, workspaceRoot, workspaces, openStorage,
    async open(models, options = {}) {
      const storage = await openStorage();
      const service = await Service.open({ storage, models, workspaces, ...options });
      services.add(service);
      storageByService.set(service, storage);
      return service;
    },
    async close(service) { await service.close(); services.delete(service); },
    async workspace(service, id, Doc) {
      const storage = storageByService.get(service);
      const record = await storage.findDocument({ kind: Doc.definition.kind,
        scope: { kind: 'conversation', conversationId: Number(id) } }, 'current', BACKGROUND_CONTEXT);
      assert.ok(record, 'conversation has a committed workspace identity');
      return (await storage.document(record.id, 'current', BACKGROUND_CONTEXT)).value;
    },
    /** A file in a workspace directory, read straight from disk. */
    async file(workspaceId, path) {
      return readFile(join(workspaceRoot, workspaceId, path), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
    },
  };
}

export async function until(check, description, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (!await check()) {
    assert.ok(Date.now() < deadline, description);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function toolRows(service, id) {
  return (await readChat(service, id)).messages.filter((message) => message.tool?.name === 'bash');
}
