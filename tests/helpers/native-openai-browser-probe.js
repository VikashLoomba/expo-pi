// Real iOS browser + Swift TCP receiver + Pi login, with an isolated in-memory account.
export default async function nativeOpenAIBrowserProbe({ action, authorizationURL }) {
  const key = '__PI_OPENAI_BROWSER_CALLBACK_PROBE';
  const requireSuffix = (suffix) => {
    const modules = globalThis.__r?.getModules?.();
    const matches = [...(modules ?? [])].filter(([, m]) => m.verboseName === suffix || (m.verboseName ?? '').endsWith(`/${suffix}`));
    if (matches.length !== 1) throw new Error('Required simulator module unavailable.');
    return globalThis.__r(matches[0][0]);
  };
  if (action === 'status') return globalThis[key]?.report ?? { phase: 'absent' };
  if (action === 'cleanup') {
    const probe = globalThis[key];
    if (probe) {
      probe.controller.abort();
      await probe.done;
      probe.restore();
      delete globalThis[key];
    }
    return { cleaned: true };
  }
  if (action !== 'start' || globalThis[key]) throw new Error('Invalid probe lifecycle.');
  const device = requireSuffix('expo/build/Expo.js').requireNativeModule('ExpoDevice');
  if (device.isDevice !== false || !['iOS', 'iPadOS'].includes(device.osName)) throw new Error('iOS simulator required.');
  const local = new URL(authorizationURL);
  if (local.hostname !== '127.0.0.1' || local.protocol !== 'http:' || local.pathname !== '/authorize') throw new Error('Local synthetic server required.');
  const receiver = requireSuffix('modules/pi-oauth-callback/src/PiOAuthCallbackModule.ts').default;
  if (!receiver) throw new Error('Rebuild simulator with the native callback module.');
  const { AuthRequest } = requireSuffix('expo-auth-session/build/AuthRequest.js');
  const { createModels, InMemoryCredentialStore } = requireSuffix('@earendil-works/pi-ai/dist/index.js');
  const { openaiProvider } = requireSuffix('@earendil-works/pi-ai/dist/providers/openai.js');
  const { createNativeOpenAIOAuth } = requireSuffix('src/pi/openai-auth/index.ts');
  const { OPENAI_DISCOVERY, OPENAI_REDIRECT_URI, OPENAI_RESOURCE, OPENAI_SCOPES } = requireSuffix('src/pi/openai-auth/core.ts');
  const store = new InMemoryCredentialStore();
  const models = createModels({ credentials: store, authContext: { env: async () => undefined, fileExists: async () => false } });
  const provider = openaiProvider();
  models.setProvider({ ...provider, auth: { ...provider.auth, oauth: createNativeOpenAIOAuth() } });
  const controller = new AbortController();
  const originalPrompt = AuthRequest.prototype.promptAsync;
  const originalFetch = globalThis.fetch;
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  let verifier;
  let tokenRequests = 0;
  let manualPrompts = 0;
  let realBrowserCalls = 0;
  let protocolMatches = false;
  const probe = { controller, report: { phase: 'pending' }, done: undefined,
    restore() {
      AuthRequest.prototype.promptAsync = originalPrompt;
      if (fetchDescriptor) Object.defineProperty(globalThis, 'fetch', fetchDescriptor);
      else globalThis.fetch = originalFetch;
    } };
  globalThis[key] = probe;
  AuthRequest.prototype.promptAsync = function (_discovery, options) {
    realBrowserCalls++;
    verifier = this.codeVerifier;
    const original = new URL(options.url);
    protocolMatches = original.searchParams.get('redirect_uri') === OPENAI_REDIRECT_URI
      && original.searchParams.get('code_challenge_method') === 'S256';
    const url = new URL(authorizationURL);
    url.searchParams.set('state', this.state);
    return originalPrompt.call(this, { authorizationEndpoint: authorizationURL }, { url: url.toString() });
  };
  globalThis.fetch = async (url, init) => {
    const form = new URLSearchParams(init?.body);
    if (url !== OPENAI_DISCOVERY.tokenEndpoint || init?.method !== 'POST'
      || form.get('code') !== 'synthetic-native-browser-code'
      || form.get('client_id') !== 'oaiapp_synthetic_native_browser'
      || form.get('code_verifier') !== verifier || form.get('redirect_uri') !== OPENAI_REDIRECT_URI
      || form.get('resource') !== OPENAI_RESOURCE || form.get('grant_type') !== 'authorization_code') {
      throw new Error('Unexpected HTTP request blocked.');
    }
    tokenRequests++;
    return new Response(JSON.stringify({ access_token: 'synthetic-browser-access', refresh_token: 'synthetic-browser-refresh',
      expires_in: 3600, scope: OPENAI_SCOPES.join(' '), id_token: 'synthetic-not-used-for-identity' }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  probe.done = models.login('openai', 'oauth', { signal: controller.signal, notify() {},
    async prompt() { manualPrompts++; throw new Error('Native callback must complete without manual input.'); } },
  { getDeviceId: () => 'ad3615b5-2030-45f4-9d10-6c24d1e90be7' }).then(async () => {
    const credential = await store.read('openai');
    const checks = { realBrowserPresented: realBrowserCalls === 1, sdkProtocolRetained: protocolMatches,
      noManualCallback: manualPrompts === 0, oneValidatedTokenExchange: tokenRequests === 1,
      piPersistedModernCredential: credential?.type === 'oauth' && credential.access === 'synthetic-browser-access'
        && credential.clientId === 'oaiapp_synthetic_native_browser' };
    probe.report = { phase: 'complete', ok: Object.values(checks).every(Boolean), checks };
  }).catch(() => { probe.report = { phase: 'complete', ok: false,
    checks: { realBrowserPresented: realBrowserCalls === 1, noManualCallback: manualPrompts === 0, tokenExchanged: tokenRequests === 1 } }; })
    .finally(() => probe.restore());
  return { started: true };
}
