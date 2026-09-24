import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codexCredentialFromToken, validateCodexCallback,
} from '../src/pi/codex-auth/core.ts';

// Protocol validation only. App/provider runs always use real OAuth and Pi.
test('callback accepts only the exact redirect, one matching state and one code', () => {
  const redirectUri = 'piagent://auth/callback';
  const valid = `${redirectUri}?state=expected&code=one-use-code`;
  assert.equal(validateCodexCallback(valid, 'expected', redirectUri), 'one-use-code');
  for (const url of [
    valid.replace('://auth', '://evil.example'),
    valid.replace('piagent:', 'otherapp:'),
    valid.replace('://auth', '://auth:1456'),
    valid.replace('/callback', '/callback/other'),
    valid.replace('expected', 'wrong'),
    valid.replace('state=expected&', ''),
    `${valid}&state=expected`, `${valid}&code=second`, `${valid}#fragment`,
    valid.replace('://auth', '://user@auth'),
    `${redirectUri}?state=expected&code=`,
    `${redirectUri}?state=expected&error=access_denied&error_description=sensitive`,
  ]) assert.throws(() => validateCodexCallback(url, 'expected', redirectUri));
  assert.throws(() => validateCodexCallback(valid, '', redirectUri));
  const httpsRedirect = 'https://app.example.com/auth/callback';
  assert.equal(validateCodexCallback(`${httpsRedirect}?state=s&code=c`, 's', httpsRedirect), 'c');
});

test('OAuth token conversion retains refresh token, account and absolute expiry', () => {
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-123' } })).toString('base64url');
  const access = `header.${payload}.signature`;
  assert.deepEqual(codexCredentialFromToken({ access_token: access, refresh_token: 'refresh', expires_in: 3600 }, 1000), {
    type: 'oauth', access, refresh: 'refresh', expires: 3601000, accountId: 'account-123',
  });
});

test('invalid responses fail without including token or remote error content', () => {
  for (const token of [
    undefined, {}, { access_token: 'sensitive' },
    { access_token: 'sensitive', refresh_token: 'secret', expires_in: 0 },
    { access_token: 'sensitive', refresh_token: 'secret', expires_in: Infinity },
    { access_token: 'sensitive', refresh_token: 'secret', expires_in: 3600 },
    { access_token: 'a.e30.c', refresh_token: 'secret', expires_in: 3600 },
  ]) assert.throws(() => codexCredentialFromToken(token), (error) => !/sensitive|secret/.test(error.message));
});
