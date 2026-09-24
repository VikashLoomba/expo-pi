// Protocol matches Pi 0.87.1 auth/oauth/openai-codex (MIT; see LICENSE.pi).
// No desktop OAuth imports: that implementation loads Node HTTP/crypto.
export const DEVICE_VERIFICATION_URI = 'https://auth.openai.com/codex/device';
export const DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const DEVICE_API = 'https://auth.openai.com/api/accounts/deviceauth';

export interface CodexDeviceLogin {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
}

export function parseDeviceLogin(value: unknown): CodexDeviceLogin {
  const data = value as Record<string, unknown> | null;
  const interval = typeof data?.interval === 'string' ? Number(data.interval.trim()) : data?.interval;
  if (!data || typeof data.device_auth_id !== 'string' || !data.device_auth_id ||
      typeof data.user_code !== 'string' || !data.user_code ||
      typeof interval !== 'number' || !Number.isFinite(interval) || interval < 0) {
    throw new Error('OpenAI returned an invalid sign-in code response.');
  }
  return { deviceAuthId: data.device_auth_id, userCode: data.user_code, intervalSeconds: interval };
}

async function readJson(response: Response): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new Error('OpenAI returned an invalid sign-in response.'); }
}

export async function startCodexDeviceLogin(clientId: string, signal: AbortSignal): Promise<CodexDeviceLogin> {
  signal.throwIfAborted();
  const response = await fetch(`${DEVICE_API}/usercode`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }), signal,
  });
  if (!response.ok) throw new Error(`Could not request a ChatGPT sign-in code (HTTP ${response.status}). Check that device code login is enabled in your ChatGPT security settings.`);
  return parseDeviceLogin(await readJson(response));
}

export function parseDevicePoll(status: number, value: unknown):
  | { status: 'complete'; authorizationCode: string; codeVerifier: string }
  | { status: 'pending' | 'slow_down' } {
  const data = value as Record<string, unknown> | null;
  if (status >= 200 && status < 300) {
    if (typeof data?.authorization_code !== 'string' || !data.authorization_code ||
        typeof data.code_verifier !== 'string' || !data.code_verifier) {
      throw new Error('OpenAI returned an invalid device authorization.');
    }
    return { status: 'complete', authorizationCode: data.authorization_code, codeVerifier: data.code_verifier };
  }
  if (status === 403 || status === 404) return { status: 'pending' };
  const error = data?.error;
  const errorCode = typeof error === 'object' && error ? (error as Record<string, unknown>).code : error;
  if (errorCode === 'deviceauth_authorization_pending') return { status: 'pending' };
  if (errorCode === 'slow_down') return { status: 'slow_down' };
  throw new Error(`ChatGPT device authorization failed (HTTP ${status}). Please try signing in again.`);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function pollCodexDeviceLogin(device: CodexDeviceLogin, signal: AbortSignal) {
  signal.throwIfAborted();
  const polling = new AbortController();
  const abort = () => polling.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => polling.abort(new Error('ChatGPT sign-in code expired. Please sign in again.')), 900_000);
  let intervalMs = Math.max(1000, Math.floor(device.intervalSeconds * 1000));
  try {
    while (true) {
      polling.signal.throwIfAborted();
      const response = await fetch(`${DEVICE_API}/token`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }), signal: polling.signal,
      });
      // Pending responses may have no JSON body. Never surface remote error bodies.
      const data = response.status === 403 || response.status === 404 ? null : await readJson(response);
      polling.signal.throwIfAborted();
      const result = parseDevicePoll(response.status, data);
      if (result.status === 'complete') return result;
      if (result.status === 'slow_down') intervalMs += 5000;
      await delay(intervalMs, polling.signal);
    }
  } catch (error) {
    polling.signal.throwIfAborted();
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    polling.abort();
  }
}
