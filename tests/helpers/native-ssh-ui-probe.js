import { router } from 'expo-router';

/** Exercise real mounted product handlers and native settings storage. No runtime/service substitutions. */
export default async function probe({ config, signal }) {
  const checks = [];
  const check = (value, message) => { if (!value) throw new Error(message); checks.push(message); };
  const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const props = () => {
    const items = [];
    for (const renderer of hook.renderers.keys()) for (const root of hook.getFiberRoots(renderer)) {
      const stack = [root.current];
      while (stack.length) { const fiber = stack.pop();
        // Navigation retains covered modal screens. Only the focused route may
        // supply callbacks; hidden copies can have the same testIDs and drafts.
        const navigation = fiber.memoizedProps?.navigation;
        if (typeof navigation?.isFocused === 'function' && !navigation.isFocused()) continue;
        if (fiber.memoizedProps?.testID) items.push(fiber.memoizedProps);
        for (let child = fiber.child; child; child = child.sibling) stack.push(child); }
    }
    return items;
  };
  const get = (id, handler) => props().find((p) => p.testID === id && (!handler || typeof p[handler] === 'function'));
  const until = async (fn, message, ms = 20000) => { const end = Date.now() + ms; while (!fn()) { signal.throwIfAborted(); if (Date.now() > end) throw new Error(message); await sleep(30); } };
  const tap = async (id) => { await until(() => get(id, 'onPress') && !get(id, 'onPress').disabled, `Button unavailable: ${id}`); get(id, 'onPress').onPress(); await sleep(100); };
  const type = async (id, value) => { await until(() => get(id, 'onChangeText'), `Input missing: ${id}`); get(id, 'onChangeText').onChangeText(value);
    await until(() => get(id, 'onChangeText')?.value === value, `Input update failed: ${id}`); };
  const notice = () => get('remote-host-notice')?.message ?? '';
  const name = `Phone verification ${Date.now()}`;
  // Remove screens left by an interrupted earlier probe before resolving testIDs.
  router.dismissTo('/');
  await until(() => get('new-chat') && !get('remote-hosts-screen') && !get('chat-settings-screen'), 'Previous settings screens did not close');
  router.push('/remote-hosts');
  await until(() => get('add-remote-host', 'onPress'), 'Machine settings did not open');
  const existingHostIds = new Set(props().filter((p) => p.testID?.startsWith('remote-machine-')).map((p) => p.testID));
  await tap('add-remote-host');
  check(!get('remote-host-daemon-path'), 'machine form has no daemon path setting');
  check(!get('remote-host-cwd'), 'machine form has no working directory setting');
  for (const [id, value] of Object.entries({name, hostname:config.host.hostname,port:String(config.host.port),username:config.host.username})) await type(`remote-host-${id}`,value);
  await tap('remote-host-key-method');
  await type('remote-host-private-key',config.privateKey);
  await tap('remote-host-save');
  await until(() => notice().includes('saved.'), 'Host save did not complete');
  check(!get('remote-host-private-key'), 'private-key input unmounted after secure save');
  const cards = props().filter((p) => p.testID?.startsWith('remote-machine-') && !existingHostIds.has(p.testID));
  const ids = [...new Set(cards.map((p) => p.testID.slice('remote-machine-'.length)))];
  // Fiber traversal order need not match the repository's insertion order.
  check(ids.length === 1, 'exactly one new host appears in product settings');
  const hostId = ids[0];
  await tap(`test-remote-host-${hostId}`);
  await until(() => get('remote-host-trust-challenge'), 'Unknown SSH host key challenge missing',40000);
  check(get('remote-host-fingerprint')?.children === config.trustedHostKey.fingerprint,'displayed fingerprint matches independently generated server key');
  await tap('reject-remote-host-key');
  await until(() => notice().includes('not accepted'),'host key rejection feedback missing');
  checks.push('unknown SSH host key can be rejected through settings');
  await tap(`test-remote-host-${hostId}`);
  await until(() => get('remote-host-trust-challenge'),'SSH key challenge missing on retry',40000);
  await tap('accept-remote-host-key');
  await until(() => {
    const message = notice();
    if (message && !message.startsWith('Connected to')) throw new Error(`Machine test failed: ${message}`);
    return message.startsWith('Connected to');
  },'Automatic remote setup and connection test failed',180000);
  checks.push('explicit trust acceptance and automatic remote execution setup pass without a project directory');
  await tap('close-remote-hosts');
  await until(() => get('new-chat') && !get('remote-hosts-screen'), 'Machine settings did not close');
  await tap('new-chat');
  await until(() => get('conversation-screen'),'new chat did not open');
  await tap('open-chat-settings');
  await tap('settings-environment');
  await tap(`settings-choice-${hostId}`);
  check(get('settings-cwd','onChangeText')?.value === '', 'new remote chat directory draft starts blank for account home');
  await tap('save-chat-settings');
  await until(() => !get('chat-settings-screen'),'remote home settings did not save',180000);
  await tap('open-chat-settings');
  const resolvedHomeCwd = get('settings-cwd','onChangeText')?.value;
  check(typeof resolvedHomeCwd === 'string' && resolvedHomeCwd.startsWith('/'), 'blank remote directory saves and reopens an absolute path');
  if (config.home) check(resolvedHomeCwd === config.home, 'blank remote directory resolves to the independently supplied account home');
  await type('settings-cwd',`${config.host.defaultCwd}/does-not-exist`);
  await tap('save-chat-settings');
  await until(() => /does not exist|not a directory/i.test(get('settings-save-error')?.message ?? ''),'missing chat directory feedback missing',180000);
  check(!!get('chat-settings-screen'), 'invalid chat directory keeps settings open');
  await tap('cancel-chat-settings');
  await tap('open-chat-settings');
  check(get('settings-cwd','onChangeText')?.value === resolvedHomeCwd, 'rejected directory save preserves the committed chat directory');
  await type('settings-cwd',config.host.defaultCwd);
  await tap('save-chat-settings');
  await until(() => !get('chat-settings-screen'),'execution settings did not save',180000);
  await tap('open-chat-settings');
  check(get('settings-environment')?.value === name,'reopened settings project committed remote machine');
  check(get('settings-cwd','onChangeText')?.value === config.host.defaultCwd,'reopened settings project committed remote cwd');
  const remoteDraft = `${config.host.defaultCwd}/editor-only-draft`;
  const localDraft = '/workspace/editor-only-draft';
  await type('settings-cwd',remoteDraft);
  await tap('settings-environment');
  await tap('settings-choice-local');
  await type('settings-cwd',localDraft);
  await tap('settings-environment');
  await tap(`settings-choice-${hostId}`);
  check(get('settings-cwd','onChangeText')?.value === remoteDraft,'switching back restores this editor’s remote directory draft');
  await tap('settings-environment');
  await tap('settings-choice-local');
  check(get('settings-cwd','onChangeText')?.value === localDraft,'switching back restores this editor’s local directory draft');
  await tap('cancel-chat-settings');
  await tap('open-chat-settings');
  check(get('settings-environment')?.value === name && get('settings-cwd','onChangeText')?.value === config.host.defaultCwd,
    'cancelling draft target switches preserves the committed remote target and directory');
  await tap('cancel-chat-settings');
  return {ok:true,hermes:typeof globalThis.HermesInternal==='object',hostId,hostName:name,resolvedHomeCwd,
    coverage:'actual mounted product handlers and native settings storage; no synthetic pointer/keyboard events',checks};
}
