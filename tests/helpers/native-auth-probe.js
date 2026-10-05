// Serialized into a development Hermes runtime. Never uses the app credential key.
export default async function nativeAuthProbe({ stage, namespace }) {
  const checks = {};
  let step = 'validate_parameters';
  let restoreFetch;
  try {
    if (!['prepare', 'verify', 'cleanup'].includes(stage)
      || !/^pi\.auth\.validation\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(namespace)) {
      throw new Error('Invalid probe parameters.');
    }
    checks.hermes = typeof globalThis.HermesInternal === 'object';
    if (!checks.hermes) throw new Error('Hermes is required.');
    const modules = globalThis.__r?.getModules?.();
    if (!modules) throw new Error('A Metro development module registry is required.');
    function requireSuffix(suffix) {
      const matches = [...modules].filter(([, module]) => {
        const path = (module.verboseName || '').replace(/\\/g, '/');
        return path === suffix || path.endsWith(`/${suffix}`);
      });
      if (matches.length !== 1) throw new Error('Expected one matching loaded module.');
      return globalThis.__r(matches[0][0]);
    }
    step = 'load_secure_store_module';
    const SecureStore = requireSuffix('expo-secure-store/build/SecureStore.js');
    step = 'check_native_secure_store';
    checks.nativeSecureStoreAvailable = await SecureStore.isAvailableAsync();
    if (!checks.nativeSecureStoreAvailable) throw new Error('Native SecureStore is unavailable.');
    step = 'load_credential_store_module';
    const { ObservableCredentialStore } = requireSuffix('src/pi/codex-auth/credential-store.ts');
    step = 'load_auth_modules';
    const { createNativeCodexOAuth, CODEX_PROVIDER_ID } = requireSuffix('src/pi/codex-auth/index.ts');
    const { CODEX_CLIENT_ID, CODEX_DISCOVERY } = requireSuffix('src/pi/codex-auth/core.ts');
    const options = {
      keychainService: 'com.vikashloomba.piagent.oauth',
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      requireAuthentication: false,
    };
    const backend = {
      getItemAsync: (key) => SecureStore.getItemAsync(key, options),
      setItemAsync: (key, value) => SecureStore.setItemAsync(key, value, options),
      deleteItemAsync: (key) => SecureStore.deleteItemAsync(key, options),
    };
    const makeStore = () => new ObservableCredentialStore(backend, namespace);
    const marker = `__PI_AUTH_PROBE_PREPARED_${namespace}`;
    const accountId = 'native-auth-probe-account';
    const syntheticAccess = (generation) => {
      const encode = (value) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
      // Exercise a large OAuth response: access JWT > 8 KiB and refresh > 2 KiB.
      const payload = { 'https://api.openai.com/auth': { chatgpt_account_id: accountId },
        generation, namespace, padding: 'x'.repeat(6200) };
      return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.synthetic`;
    };
    const initialAccess = syntheticAccess('expired');
    const rotatedAccess = syntheticAccess('rotated');
    const initialRefresh = `synthetic-initial-${namespace}-${'r'.repeat(2048)}`;
    const rotatedRefresh = `synthetic-rotated-${namespace}-${'s'.repeat(2048)}`;

    if (stage === 'prepare') {
      step = 'ensure_isolated_key_is_empty';
      checks.isolatedKeyWasEmpty = await backend.getItemAsync(namespace) === null;
      if (!checks.isolatedKeyWasEmpty) throw new Error('Use a new unique probe namespace.');
      step = 'persist_expired_synthetic_credential';
      const store = makeStore();
      const credential = { type: 'oauth', access: initialAccess, refresh: initialRefresh,
        expires: Date.now() - 60_000, accountId };
      await store.modify(CODEX_PROVIDER_ID, async () => credential);
      step = 'verify_native_prepare_write';
      const raw = await backend.getItemAsync(namespace);
      const persisted = raw === null ? undefined : JSON.parse(raw).credential;
      checks.expiredCredentialPersisted = persisted?.access === initialAccess && persisted?.refresh === initialRefresh
        && persisted?.accountId === accountId && persisted?.expires < Date.now();
      checks.largeCredentialPersisted = typeof raw === 'string' && initialAccess.length >= 8192 && initialRefresh.length >= 2048;
      checks.preparedStoreSignedIn = store.getSnapshot().ready && store.getSnapshot().signedIn;
      globalThis[marker] = true;
    } else if (stage === 'cleanup') {
      step = 'delete_isolated_credential';
      await makeStore().delete(CODEX_PROVIDER_ID);
      step = 'verify_cleanup_with_fresh_store';
      const fresh = makeStore();
      checks.freshStoreHasNoCredential = await fresh.read(CODEX_PROVIDER_ID) === undefined;
      checks.freshStoreSignedOut = fresh.getSnapshot().ready && !fresh.getSnapshot().signedIn;
      checks.nativeKeyAbsent = await backend.getItemAsync(namespace) === null;
      delete globalThis[marker];
    } else {
      step = 'verify_javascript_runtime_restarted';
      checks.javascriptRuntimeRestarted = globalThis[marker] !== true;
      if (!checks.javascriptRuntimeRestarted) throw new Error('Reload or restart the app between prepare and verify.');
      step = 'restore_expired_credential_in_new_runtime';
      const store = makeStore();
      await store.restore();
      const restored = await store.read(CODEX_PROVIDER_ID);
      checks.expiredCredentialRestored = restored?.access === initialAccess && restored?.refresh === initialRefresh
        && restored?.accountId === accountId && restored?.expires < Date.now();
      checks.restoredStoreSignedIn = store.getSnapshot().ready && store.getSnapshot().signedIn;
      if (!checks.expiredCredentialRestored) throw new Error('The prepared credential was not restored.');
      step = 'load_pi_models';
      const { createModels } = requireSuffix('@earendil-works/pi-ai/dist/index.js');
      const { openaiCodexProvider } = requireSuffix('@earendil-works/pi-ai/dist/providers/openai-codex.js');
      const models = createModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
      models.setProvider({ ...openaiCodexProvider(), auth: { oauth: createNativeCodexOAuth() } });
      let requests = 0;
      let unexpectedRequests = 0;
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
      const originalFetch = globalThis.fetch;
      step = 'install_no_network_token_interceptor';
      globalThis.fetch = async (url, init) => {
        requests++;
        const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
        if (url !== CODEX_DISCOVERY.tokenEndpoint || init?.method !== 'POST'
          || form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== initialRefresh
          || form.get('client_id') !== CODEX_CLIENT_ID) {
          unexpectedRequests++;
          // Never forward to the original fetch, including unexpected requests.
          throw new Error('The probe blocked an unexpected network request.');
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        init.signal?.throwIfAborted();
        return new Response(JSON.stringify({ access_token: rotatedAccess, refresh_token: rotatedRefresh, expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } });
      };
      restoreFetch = () => {
        if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
        else globalThis.fetch = originalFetch;
      };
      step = 'concurrent_real_pi_auth_refresh';
      const results = await Promise.all(Array.from({ length: 3 }, () => models.getAuth(CODEX_PROVIDER_ID)));
      checks.singleRefreshForConcurrentRequests = requests === 1;
      checks.noUnexpectedNetworkRequests = unexpectedRequests === 0;
      checks.allRequestsUseRotatedAccess = results.every((result) => result?.auth?.apiKey === rotatedAccess);
      step = 'verify_rotated_credential_in_fresh_store';
      const fresh = makeStore();
      const rotated = await fresh.read(CODEX_PROVIDER_ID);
      checks.rotatedCredentialPersisted = rotated?.access === rotatedAccess && rotated?.refresh === rotatedRefresh
        && rotated?.accountId === accountId && rotated?.expires > Date.now() + 55 * 60_000;
      checks.freshStoreSignedIn = fresh.getSnapshot().ready && fresh.getSnapshot().signedIn;
      const beforeFreshAuth = requests;
      const freshModels = createModels({ credentials: fresh, authContext: { env: async () => undefined, fileExists: async () => false } });
      freshModels.setProvider({ ...openaiCodexProvider(), auth: { oauth: createNativeCodexOAuth() } });
      checks.freshModelsUseSavedAccess = (await freshModels.getAuth(CODEX_PROVIDER_ID))?.auth?.apiKey === rotatedAccess;
      checks.validSavedTokenNeedsNoRefresh = requests === beforeFreshAuth;
    }
    return { ok: Object.values(checks).every(Boolean), stage, namespace, checks };
  } catch {
    // Neither native error text nor token response bodies enter the report.
    return { ok: false, stage, namespace, failure: step, checks };
  } finally {
    restoreFetch?.();
  }
}
