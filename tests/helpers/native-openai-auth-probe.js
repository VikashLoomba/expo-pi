// Serialized into a simulator Hermes runtime. Every credential uses one isolated key.
export default async function nativeOpenAIAuthProbe({ stage, namespace }) {
  const checks = {};
  let step = 'validate_parameters';
  let restoreFetch;
  let restoreBrowser;
  try {
    if (!['prepare', 'verify', 'cleanup'].includes(stage)
      || !/^pi\.openai\.auth\.validation\.v1\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(namespace)) {
      throw new Error('Invalid probe parameters.');
    }
    checks.hermes = typeof globalThis.HermesInternal === 'object';
    if (!checks.hermes) throw new Error('Hermes is required.');
    const modules = globalThis.__r?.getModules?.();
    if (!modules) throw new Error('A Metro module registry is required.');
    function requireSuffix(suffix) {
      const matches = [...modules].filter(([, module]) => {
        const path = (module.verboseName || '').replace(/\\/g, '/');
        return path === suffix || path.endsWith(`/${suffix}`);
      });
      if (matches.length !== 1) throw new Error('Expected one matching loaded module.');
      return globalThis.__r(matches[0][0]);
    }
    step = 'load_native_and_sdk_modules';
    const SecureStore = requireSuffix('expo-secure-store/build/SecureStore.js');
    const Crypto = requireSuffix('expo-crypto/build/Crypto.js');
    const { AuthRequest } = requireSuffix('expo-auth-session/build/AuthRequest.js');
    const { createModels } = requireSuffix('@earendil-works/pi-ai/dist/index.js');
    const { openaiProvider } = requireSuffix('@earendil-works/pi-ai/dist/providers/openai.js');
    const { ObservableCredentialStore } = requireSuffix('src/pi/codex-auth/credential-store.ts');
    const { ProviderCredentialStore, providerCredentialKey } = requireSuffix('src/pi/provider-credentials.ts');
    const { createNativeOpenAIOAuth } = requireSuffix('src/pi/openai-auth/index.ts');
    const { OPENAI_PROVIDER_ID, OPENAI_DISCOVERY, OPENAI_DYNAMIC_CLIENT_ID, OPENAI_REDIRECT_URI,
      OPENAI_RESOURCE, OPENAI_SCOPES, OPENAI_DIRECT_SCOPE, isCompletedOpenAIRefresh, isPermanentOpenAIAuthError,
      validateOpenAICredential } = requireSuffix('src/pi/openai-auth/core.ts');
    checks.nativeSecureStoreAvailable = await SecureStore.isAvailableAsync();
    if (!checks.nativeSecureStoreAvailable) throw new Error('Native SecureStore is unavailable.');
    const options = { keychainService: 'com.vikashloomba.piagent.oauth',
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY, requireAuthentication: false };
    const native = {
      read: () => SecureStore.getItemAsync(namespace, options),
      write: (value) => SecureStore.setItemAsync(namespace, value, options),
      remove: () => SecureStore.deleteItemAsync(namespace, options),
    };
    let unexpectedStorageAccess = 0;
    const allowedKey = providerCredentialKey(OPENAI_PROVIDER_ID);
    const guardKey = (key) => {
      if (key !== allowedKey) { unexpectedStorageAccess++; throw new Error('Unexpected credential key.'); }
    };
    const backend = {
      async getItemAsync(key) { guardKey(key); return native.read(); },
      async setItemAsync(key, value) { guardKey(key); return native.write(value); },
      async deleteItemAsync(key) { guardKey(key); return native.remove(); },
    };
    let legacyStorageAccess = 0;
    const legacyBlocked = () => { legacyStorageAccess++; throw new Error('Legacy credentials must not be accessed.'); };
    const makeStore = () => {
      const legacy = new ObservableCredentialStore({ getItemAsync: legacyBlocked, setItemAsync: legacyBlocked,
        deleteItemAsync: legacyBlocked }, `${namespace}.legacy-never-access`);
      const store = new ProviderCredentialStore(legacy, backend, { [OPENAI_PROVIDER_ID]: {
        validate: validateOpenAICredential, isCompletedRefresh: isCompletedOpenAIRefresh, isPermanentAuthError: isPermanentOpenAIAuthError,
      } });
      store.registerProviders([OPENAI_PROVIDER_ID]);
      return store;
    };
    const makeModels = (store) => {
      const models = createModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
      const provider = openaiProvider();
      models.setProvider({ ...provider, auth: { ...provider.auth, oauth: createNativeOpenAIOAuth() } });
      return models;
    };
    const marker = `__PI_OPENAI_AUTH_PROBE_PREPARED_${namespace}`;
    const clientId = 'native-openai-probe-issued-client';
    const initialAccess = `synthetic-modern-access-${namespace}-${'x'.repeat(8192)}`;
    const initialRefresh = `synthetic-modern-refresh-${namespace}-${'r'.repeat(2048)}`;
    const rotatedAccess = `synthetic-rotated-access-${namespace}-${'y'.repeat(8192)}`;
    const rotatedRefresh = `synthetic-rotated-refresh-${namespace}-${'s'.repeat(2048)}`;
    const installFetch = (intercept) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
      const original = globalThis.fetch;
      globalThis.fetch = intercept;
      restoreFetch = () => {
        if (descriptor) Object.defineProperty(globalThis, 'fetch', descriptor);
        else globalThis.fetch = original;
      };
    };
    const response = (token) => new Response(JSON.stringify(token), { status: 200, headers: { 'content-type': 'application/json' } });

    if (stage === 'prepare') {
      step = 'ensure_isolated_key_empty';
      checks.isolatedKeyWasEmpty = await native.read() === null;
      if (!checks.isolatedKeyWasEmpty) throw new Error('Use a new unique probe namespace.');
      let browserMode = 'success';
      let authUrl;
      let currentVerifier;
      let browserCalls = 0;
      let manualPrompts = 0;
      let requests = 0;
      let unexpectedRequests = 0;
      const hostId = Crypto.randomUUID();
      const states = new Set();
      const nonces = new Set();
      const pkceMatches = [];
      const protocolMatches = [];
      const buildCallback = () => {
        const callback = new URL(OPENAI_REDIRECT_URI);
        callback.searchParams.set('code', 'synthetic-modern-code');
        callback.searchParams.set('client_id', clientId);
        callback.searchParams.set('state', new URL(authUrl).searchParams.get('state'));
        return callback.toString();
      };
      step = 'intercept_browser_presentation_only';
      const originalPrompt = AuthRequest.prototype.promptAsync;
      AuthRequest.prototype.promptAsync = async function (_discovery, browserOptions) {
        browserCalls++;
        authUrl = browserOptions.url;
        const url = new URL(authUrl);
        currentVerifier = this.codeVerifier;
        const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, currentVerifier,
          { encoding: Crypto.CryptoEncoding.BASE64 });
        pkceMatches.push(url.searchParams.get('code_challenge') === digest.replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'));
        states.add(url.searchParams.get('state'));
        nonces.add(url.searchParams.get('nonce'));
        protocolMatches.push(url.origin + url.pathname === OPENAI_DISCOVERY.authorizationEndpoint
          && url.searchParams.get('client_id') === OPENAI_DYNAMIC_CLIENT_ID
          && url.searchParams.get('redirect_uri') === OPENAI_REDIRECT_URI
          && url.searchParams.get('resource') === OPENAI_RESOURCE
          && url.searchParams.get('ext_agent_host_id') === `urn:uuid:${hostId}`
          && url.searchParams.get('code_challenge_method') === 'S256'
          && OPENAI_SCOPES.every((scope) => url.searchParams.get('scope').split(' ').includes(scope)));
        if (browserMode === 'failure') throw new Error('Synthetic browser presentation failure');
        return this.parseReturnUrl(buildCallback());
      };
      restoreBrowser = () => { AuthRequest.prototype.promptAsync = originalPrompt; };
      step = 'install_no_network_authorization_interceptor';
      installFetch(async (url, init) => {
        requests++;
        const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
        if (url !== OPENAI_DISCOVERY.tokenEndpoint || init?.method !== 'POST'
          || form.get('grant_type') !== 'authorization_code' || form.get('code') !== 'synthetic-modern-code'
          || form.get('client_id') !== clientId || form.get('redirect_uri') !== OPENAI_REDIRECT_URI
          || form.get('code_verifier') !== currentVerifier || form.get('resource') !== OPENAI_RESOURCE) {
          unexpectedRequests++; throw new Error('Unexpected network request blocked.');
        }
        return response({ access_token: initialAccess, refresh_token: initialRefresh, expires_in: 3600,
          scope: OPENAI_SCOPES.join(' '), id_token: 'synthetic-id-token-not-used-as-identity' });
      });
      const store = makeStore();
      const models = makeModels(store);
      const interaction = {
        signal: new AbortController().signal,
        notify(event) { if (event.type === 'auth_url') authUrl = event.url; },
        async prompt(prompt) {
          manualPrompts++;
          if (prompt.type !== 'manual_code' || browserMode !== 'failure') throw new Error('Unexpected prompt.');
          return buildCallback();
        },
      };
      step = 'native_pkce_browser_callback_login';
      await models.login(OPENAI_PROVIDER_ID, 'oauth', interaction, { getDeviceId: () => hostId });
      checks.browserCallbackLogin = browserCalls === 1 && manualPrompts === 0 && requests === 1;
      step = 'native_browser_failure_manual_code_login';
      browserMode = 'failure';
      await models.login(OPENAI_PROVIDER_ID, 'oauth', interaction, { getDeviceId: () => hostId });
      checks.manualCodeFallbackLogin = browserCalls === 2 && manualPrompts === 1 && requests === 2;
      checks.nativePkceChallengesVerified = pkceMatches.length === 2 && pkceMatches.every(Boolean);
      checks.sdkProtocolParameters = protocolMatches.length === 2 && protocolMatches.every(Boolean);
      checks.freshStateAndNoncePerAttempt = states.size === 2 && nonces.size === 2
        && new Set([...states, ...nonces]).size === 4
        && [...states, ...nonces].every((value) => typeof value === 'string' && value.length >= 32);
      checks.noUnexpectedNetworkRequests = unexpectedRequests === 0;
      step = 'persist_expired_login_for_reload';
      await store.modify(OPENAI_PROVIDER_ID, async (credential) => ({ ...credential, expires: Date.now() - 60_000 }));
      const raw = await native.read();
      const persisted = raw === null ? undefined : JSON.parse(raw).credential;
      checks.loginCredentialPersisted = persisted?.access === initialAccess && persisted?.refresh === initialRefresh
        && persisted?.clientId === clientId && persisted?.scopes.includes(OPENAI_DIRECT_SCOPE) && persisted?.expires < Date.now();
      checks.largeCredentialPersisted = typeof raw === 'string' && raw.length > 10_000;
      const access = store.getProviderSnapshot(OPENAI_PROVIDER_ID);
      checks.publishesOnlyCredentialMetadata = access.ready && access.connected && access.type === 'oauth'
        && !JSON.stringify(store.getSnapshot()).includes('synthetic-');
      globalThis[marker] = true;
    } else if (stage === 'verify') {
      step = 'require_fresh_javascript_runtime';
      checks.javascriptRuntimeRestarted = globalThis[marker] !== true;
      if (!checks.javascriptRuntimeRestarted) throw new Error('Reload is required between prepare and verify.');
      const store = makeStore();
      step = 'restore_modern_credential_after_reload';
      await store.restoreProvider(OPENAI_PROVIDER_ID);
      const restored = await store.read(OPENAI_PROVIDER_ID);
      checks.expiredCredentialRestored = restored?.access === initialAccess && restored?.refresh === initialRefresh
        && restored?.clientId === clientId && restored?.scopes.includes(OPENAI_DIRECT_SCOPE) && restored?.expires < Date.now();
      if (!checks.expiredCredentialRestored) throw new Error('The prepared credential was not restored.');
      let requests = 0;
      let unexpectedRequests = 0;
      step = 'install_no_network_refresh_interceptor';
      installFetch(async (url, init) => {
        requests++;
        const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
        if (url !== OPENAI_DISCOVERY.tokenEndpoint || init?.method !== 'POST'
          || form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== initialRefresh
          || form.get('client_id') !== clientId || form.get('resource') !== OPENAI_RESOURCE) {
          unexpectedRequests++; throw new Error('Unexpected network request blocked.');
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        init.signal?.throwIfAborted();
        return response({ access_token: rotatedAccess, refresh_token: rotatedRefresh, expires_in: 3600 });
      });
      step = 'concurrent_pi_refresh_with_native_storage';
      const models = makeModels(store);
      const results = await Promise.all(Array.from({ length: 3 }, () => models.getAuth(OPENAI_PROVIDER_ID)));
      checks.singleRefreshForConcurrentRequests = requests === 1;
      checks.allRequestsUseRotatedAccess = results.every((result) => result?.auth?.apiKey === rotatedAccess);
      checks.noUnexpectedNetworkRequests = unexpectedRequests === 0;
      step = 'restore_rotated_token_with_new_store';
      const fresh = makeStore();
      const rotated = await fresh.read(OPENAI_PROVIDER_ID);
      checks.rotatedCredentialPersisted = rotated?.access === rotatedAccess && rotated?.refresh === rotatedRefresh
        && rotated?.clientId === clientId && rotated?.scopes.includes(OPENAI_DIRECT_SCOPE)
        && rotated?.expires > Date.now() + 55 * 60_000;
      const before = requests;
      checks.freshModelsUseSavedAccess = (await makeModels(fresh).getAuth(OPENAI_PROVIDER_ID))?.auth?.apiKey === rotatedAccess;
      checks.savedAccessDoesNotRefreshAgain = requests === before;
    } else {
      step = 'delete_isolated_credential';
      await makeStore().delete(OPENAI_PROVIDER_ID);
      const fresh = makeStore();
      checks.freshStoreHasNoCredential = await fresh.read(OPENAI_PROVIDER_ID) === undefined;
      checks.freshStoreDisconnected = fresh.getProviderSnapshot(OPENAI_PROVIDER_ID).ready && !fresh.getProviderSnapshot(OPENAI_PROVIDER_ID).connected;
      checks.nativeKeyAbsent = await native.read() === null;
      delete globalThis[marker];
    }
    checks.legacyCredentialsNeverAccessed = legacyStorageAccess === 0;
    checks.onlyIsolatedCredentialAccessed = unexpectedStorageAccess === 0;
    return { ok: Object.values(checks).every(Boolean), stage, namespace, checks };
  } catch {
    // Never return server bodies, credentials, auth URLs, or raw native errors.
    return { ok: false, stage, namespace, failure: step, checks };
  } finally {
    restoreBrowser?.();
    restoreFetch?.();
  }
}
