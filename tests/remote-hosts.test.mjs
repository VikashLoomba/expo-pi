import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/execution/remote/hosts.ts')) return { shortCircuit: true, format: 'module',
      source: stripTypeScriptTypes(readFileSync(new URL(url), 'utf8'), { mode: 'transform' }) };
    return nextLoad(url, context);
  },
});
const { RemoteHostRepository, matchesHostKey } = await import('../src/pi/execution/remote/hosts.ts');
hooks.deregister();
function backend() {
  const values = new Map();
  return { values, getItemAsync: async (key) => values.get(key) ?? null,
    setItemAsync: async (key, value) => { values.set(key, value); }, deleteItemAsync: async (key) => { values.delete(key); } };
}
function fixture() {
  const metadata = backend(), secrets = backend();
  let id = 0;
  const open = () => new RemoteHostRepository(metadata, secrets, () => `fixture-${++id}`);
  return { metadata, secrets, open, repo: open() };
}
const settings = { name: 'Test Mac', hostname: 'mac.tailnet.ts.net', port: 22, username: 'operator' };
const password = { type: 'password', password: 'synthetic-secret' };
const key = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abcd', publicKey: 'abcd' };

test('machine settings and secure host trust survive reopen without publishing secrets', async () => {
  const { repo, open, metadata, secrets } = fixture();
  assert.equal(repo.getSnapshot().ready, false);
  const host = await repo.save(settings, password);
  assert.equal(repo.getSnapshot().ready, true);
  assert.equal(repo.get(host.id), host);
  const accepted = await repo.acceptHostKey(host.id, host.revision, key);
  const reopened = open();
  await reopened.restore();
  assert.equal(reopened.get(host.id).revision, accepted.revision);
  const admission = await reopened.admit(host.id);
  assert.deepEqual(admission.auth, password);
  assert.deepEqual(admission.trustedHostKey, key);
  assert.doesNotMatch(JSON.stringify(reopened.getSnapshot()), /synthetic-secret|SHA256|publicKey/);
  assert.doesNotMatch([...metadata.values.values()].join(), /synthetic-secret|SHA256|publicKey/);
  assert.equal(secrets.values.size, 1);
});

test('admitted sessions retain immutable endpoint, credentials, and trust across edits and removal', async () => {
  const { repo } = fixture();
  const original = await repo.save(settings, password);
  const host = await repo.acceptHostKey(original.id, original.revision, key);
  const admitted = await repo.admit(host.id, host.revision);
  const edited = await repo.save({ ...host, hostname: 'another.tailnet.ts.net', username: 'other' }, { type: 'password', password: 'replacement' });
  assert.equal(admitted.host.hostname, settings.hostname);
  assert.equal(admitted.auth.password, password.password);
  assert.deepEqual(admitted.trustedHostKey, key);
  assert.throws(() => { admitted.host.hostname = 'injected'; }, TypeError);
  assert.throws(() => { admitted.auth.password = 'injected'; }, TypeError);
  assert.equal((await repo.admit(host.id)).trustedHostKey, undefined, 'new endpoint requires new trust');
  await assert.rejects(repo.admit(host.id, host.revision), /changed/);
  await assert.rejects(repo.acceptHostKey(host.id, host.revision, key), /changed/);
  await repo.remove(edited.id, edited.revision);
  await assert.rejects(repo.admit(edited.id), /removed/);
  assert.equal(admitted.auth.password, password.password);
  assert.deepEqual(repo.getSnapshot().hosts, []);
});

test('same-endpoint account changes retain host trust; trust reset and changed key are explicit', async () => {
  const { repo } = fixture();
  const first = await repo.save(settings, password);
  const trusted = await repo.acceptHostKey(first.id, first.revision, key);
  const edited = await repo.save({ ...trusted, username: 'another' });
  assert.deepEqual((await repo.admit(edited.id)).trustedHostKey, key);
  assert.equal(matchesHostKey(key, { ...key, publicKey: 'efgh' }), false);
  assert.equal(matchesHostKey(key, { ...key, fingerprint: 'SHA256:efgh' }), false);
  assert.equal(matchesHostKey(key, { ...key, algorithm: 'ssh-rsa' }), false);
  assert.equal(matchesHostKey(undefined, key), false);
  assert.equal(matchesHostKey(key, key), true);
  await repo.forgetHostKey(edited.id, edited.revision);
  assert.equal((await repo.admit(edited.id)).trustedHostKey, undefined);
});

test('failed metadata publication preserves the prior secret and settings and retires the unpublished record', async () => {
  const { repo, metadata, secrets } = fixture();
  const host = await repo.save(settings, password);
  const originalSet = metadata.setItemAsync;
  let calls = 0;
  metadata.setItemAsync = async (...args) => {
    if (++calls === 2) throw new Error('storage unavailable synthetic-secret');
    return originalSet(...args);
  };
  await assert.rejects(repo.save({ ...host, username: 'replacement' }, { type: 'password', password: 'new-secret' }), /Could not save remote machine/);
  assert.equal(repo.get(host.id).username, settings.username);
  assert.equal((await repo.admit(host.id)).auth.password, password.password);
  assert.equal(secrets.values.size, 1);
});

test('retired credential cleanup survives failure and is retried after reopening', async () => {
  const { repo, open, secrets } = fixture();
  const host = await repo.save(settings, password);
  const remove = secrets.deleteItemAsync;
  secrets.deleteItemAsync = async () => { throw new Error('synthetic-secret locked'); };
  await repo.remove(host.id);
  assert.deepEqual(repo.getSnapshot().hosts, []);
  assert.match(repo.getSnapshot().cleanupError, /retired SSH credentials/);
  assert.doesNotMatch(JSON.stringify(repo.getSnapshot()), /synthetic-secret/);
  secrets.deleteItemAsync = remove;
  const reopened = open();
  await reopened.restore();
  assert.equal(secrets.values.size, 0);
  assert.equal(reopened.getSnapshot().cleanupError, undefined);
});

test('malformed metadata is preserved and never reset to an empty writable store', async () => {
  const { repo, metadata } = fixture();
  metadata.values.set('pi.remote-hosts.v1', '{broken');
  await assert.rejects(repo.restore(), /Could not restore/);
  await assert.rejects(repo.save(settings, password), /Could not restore/);
  assert.equal(metadata.values.get('pi.remote-hosts.v1'), '{broken');
});

test('missing or unreadable secure credentials fail closed and explicit replacement recovers', async () => {
  const { repo, secrets } = fixture();
  const host = await repo.save(settings, password);
  secrets.values.delete(host.credentialRef);
  await assert.rejects(repo.admit(host.id), /Could not restore.*SSH credentials/);
  const updated = await repo.save(host, { type: 'privateKey', privateKey: 'synthetic-private-key', passphrase: 'synthetic-passphrase' });
  assert.equal(updated.credentialType, 'privateKey');
  assert.equal((await repo.admit(host.id)).auth.privateKey, 'synthetic-private-key');
  assert.doesNotMatch(JSON.stringify(repo.getSnapshot()), /synthetic-private-key|synthetic-passphrase/);
});

test('settings validation and secure storage errors do not disclose input secrets', async () => {
  const { repo, secrets } = fixture();
  for (const change of [{ hostname: 'ssh://host' }, { port: 65536 }, { username: 'x\ny' }]) {
    assert.throws(() => repo.save({ ...settings, ...change }, password));
  }
  secrets.setItemAsync = async () => { throw new Error('synthetic-secret'); };
  await assert.rejects(repo.save(settings, password), { message: 'Could not save SSH credentials securely. Unlock this device and try again.' });
  assert.deepEqual(repo.getSnapshot().hosts, []);
});

test('a crash after a secure write but before publication is cleaned from the persisted journal', async () => {
  const { repo, open, metadata, secrets } = fixture();
  await repo.restore();
  metadata.values.set('pi.remote-hosts.v1', JSON.stringify({ version: 1, hosts: [], pendingDelete: ['pi.ssh.v1.interrupted'] }));
  secrets.values.set('pi.ssh.v1.interrupted', JSON.stringify({ version: 1, auth: password }));
  await open().restore();
  assert.equal(secrets.values.size, 0);
});

test('opaque namespace follows endpoint, account, and server identity without disclosing key material', async () => {
  const { repo } = fixture();
  let host = await repo.save(settings, password);
  host = await repo.acceptHostKey(host.id, host.revision, key);
  const namespace = host.namespaceId;
  host = await repo.save({ ...host, name: 'Renamed' }, { type: 'password', password: 'replacement' });
  assert.equal(host.namespaceId, namespace, 'label and credential rotation preserve remote filesystem identity');
  host = await repo.acceptHostKey(host.id, host.revision, key);
  assert.equal(host.namespaceId, namespace, 'accepting the same verified key preserves filesystem identity');
  host = await repo.acceptHostKey(host.id, host.revision, { ...key, fingerprint: 'SHA256:defg', publicKey: 'defg' });
  assert.notEqual(host.namespaceId, namespace, 'a replacement server at the same hostname gets a new identity');
  let previous = host.namespaceId;
  host = await repo.save({ ...host, username: 'new-account' });
  assert.notEqual(host.namespaceId, previous);
  previous = host.namespaceId;
  host = await repo.save({ ...host, port: 2222 });
  assert.notEqual(host.namespaceId, previous);
  assert.doesNotMatch(JSON.stringify(repo.getSnapshot()), /SHA256|publicKey|abcd|defg/);
});

test('saved machines ignore obsolete working-directory and daemon fields while retaining identity, credentials, and trust', async () => {
  const { repo, open, metadata, secrets } = fixture();
  const created = await repo.save(settings, password);
  const host = await repo.acceptHostKey(created.id, created.revision, key);
  const oldIndex = JSON.parse(metadata.values.get('pi.remote-hosts.v1'));
  // Invalid old input must have no bearing on automatic setup or host recovery.
  oldIndex.hosts[0].daemonPath = 'obsolete relative path';
  oldIndex.hosts[0].defaultCwd = { obsolete: 'invalid old directory input' };
  metadata.values.set('pi.remote-hosts.v1', JSON.stringify(oldIndex));
  const savedSecrets = new Map(secrets.values);
  const reopened = open();
  await reopened.restore();
  assert.deepEqual(reopened.get(host.id), host);
  assert.equal('daemonPath' in reopened.get(host.id), false);
  assert.equal('defaultCwd' in reopened.get(host.id), false);
  const admitted = await reopened.admit(host.id, host.revision);
  assert.equal(admitted.host.namespaceId, host.namespaceId);
  assert.equal(admitted.host.credentialRef, host.credentialRef);
  assert.deepEqual(admitted.auth, password);
  assert.deepEqual(admitted.trustedHostKey, key);
  assert.deepEqual(secrets.values, savedSecrets, 'restore leaves existing secure records untouched');
  // A stale form or caller carrying old fields cannot reintroduce them on save.
  const edited = await reopened.save({ ...oldIndex.hosts[0], name: 'Updated name' });
  assert.equal(edited.id, host.id);
  assert.equal(edited.namespaceId, host.namespaceId);
  assert.deepEqual((await reopened.admit(host.id)).auth, password);
  assert.deepEqual((await reopened.admit(host.id)).trustedHostKey, key);
  assert.doesNotMatch(JSON.stringify(reopened.getSnapshot()), /daemonPath|defaultCwd|invalid old directory/);
  assert.doesNotMatch(metadata.values.get('pi.remote-hosts.v1'), /daemonPath|defaultCwd|invalid old directory/);
  const saved = open();
  await saved.restore();
  assert.deepEqual(saved.get(host.id), edited);
});
