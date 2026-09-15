'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { googleConfig, createTokenProvider, createAuthorization, validState, saveCredentials, readCredentials, SCOPES } = require('../src/google-auth');
const { authorize, configureDestinations, setupApi } = require('../configure-google.cjs');

const credentials = { clientId: 'client', clientSecret: 'secret-sentinel', refreshToken: 'refresh-sentinel' };
test('Google config requires credentials and both destinations, and environment overrides saved config', () => {
  const saved = { ...credentials, rootFolderId: 'folder', calendarId: 'calendar' };
  assert.equal(googleConfig({}, () => saved).configured, true);
  assert.equal(googleConfig({ GOOGLE_CALENDAR_ID: '' }, () => saved).configured, false);
  assert.equal(googleConfig({}, () => credentials).credentialsConfigured, true);
  assert.equal(googleConfig({}, () => credentials).configured, false);
  assert.equal(googleConfig({ GOOGLE_DRIVE_ROOT_FOLDER_ID: 'override' }, () => saved).rootFolderId, 'override');
  const failed = googleConfig({}, () => { throw new Error('secret-sentinel'); });
  assert.equal(failed.configured, false);
  assert.ok(!failed.error.includes('secret-sentinel'));
});
test('complete environment configuration does not read private credential file', () => {
  const result = googleConfig({ GOOGLE_CLIENT_ID: 'client', GOOGLE_CLIENT_SECRET: 'secret', GOOGLE_REFRESH_TOKEN: 'token', GOOGLE_DRIVE_ROOT_FOLDER_ID: 'folder', GOOGLE_CALENDAR_ID: 'calendar' }, () => { throw new Error('must not read'); });
  assert.equal(result.configured, true);
  assert.equal(result.error, undefined);
});
test('token refresh coalesces requests and caches token until expiry', async () => {
  let calls = 0;
  const token = createTokenProvider(credentials, async (url, options) => {
    calls++;
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body.get('refresh_token'), credentials.refreshToken);
    return { ok: true, json: async () => ({ access_token: 'access', expires_in: 3600 }) };
  });
  assert.deepEqual(await Promise.all([token(), token(), token()]), ['access', 'access', 'access']);
  assert.equal(await token(), 'access');
  assert.equal(calls, 1);
});
test('short-lived tokens are refreshed and network/API failures never surface secrets', async () => {
  let calls = 0;
  const token = createTokenProvider(credentials, async () => ({ ok: true, json: async () => ({ access_token: `access-${++calls}`, expires_in: 10 }) }));
  assert.equal(await token(), 'access-1');
  assert.equal(await token(), 'access-2');
  await assert.rejects(createTokenProvider(credentials, async () => { throw new Error('secret-sentinel refresh-sentinel'); }), error => !error.message.includes('sentinel'));
  await assert.rejects(createTokenProvider(credentials, async () => ({ ok: false, status: 400, json: async () => ({ error_description: 'secret-sentinel' }) })), /expired or was revoked/);
});
test('PKCE uses unique high-entropy state/verifier, S256 and restricted scopes', () => {
  const first = createAuthorization('client', 'http://127.0.0.1:32101/');
  const second = createAuthorization('client', 'http://127.0.0.1:32101/');
  const url = new URL(first.url);
  assert.notEqual(first.state, second.state);
  assert.notEqual(first.verifier, second.verifier);
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(url.searchParams.get('code_challenge'), crypto.createHash('sha256').update(first.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.equal(validState(first.state, first.state), true);
  assert.equal(validState(first.state + 'x', first.state), false);
  assert.equal(validState(null, first.state), false);
  assert.equal(validState('', ''), false);
});
test('loopback authorization rejects wrong state and exchanges only the valid code with PKCE', async () => {
  let callbackDone;
  const callback = new Promise(resolve => { callbackDone = resolve; });
  let challenge, redirect;
  const result = await authorize({ client_id: 'client', client_secret: 'secret' }, message => {
    const url = new URL(message.match(/https:\/\/accounts[^\s]+/)[0]);
    challenge = url.searchParams.get('code_challenge');
    redirect = url.searchParams.get('redirect_uri');
    (async () => {
      const wrong = new URL(redirect); wrong.search = new URLSearchParams({ state: 'wrong', code: 'wrong-code' });
      assert.equal((await fetch(wrong)).status, 400);
      const correct = new URL(redirect); correct.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'valid-code' });
      assert.equal((await fetch(correct)).status, 200);
      callbackDone();
    })().catch(callbackDone);
  }, async (url, options) => {
    assert.equal(url, 'https://oauth2.googleapis.com/token');
    assert.equal(options.body.get('code'), 'valid-code');
    assert.equal(options.body.get('redirect_uri'), redirect);
    assert.equal(crypto.createHash('sha256').update(options.body.get('code_verifier')).digest('base64url'), challenge);
    return { ok: true, json: async () => ({ refresh_token: 'new-refresh' }) };
  });
  const callbackError = await callback;
  if (callbackError) throw callbackError;
  assert.equal(result.refreshToken, 'new-refresh');
});
test('DPAPI stores no plaintext and supports atomic update under current Windows account', { skip: process.platform !== 'win32' || process.env.FDE_TEST_DPAPI !== '1' ? 'Opt in with FDE_TEST_DPAPI=1 under a loaded Windows user profile.' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-google-auth-'));
  const filename = path.join(dir, 'credentials.dpapi');
  try {
    saveCredentials(credentials, filename);
    assert.ok(!fs.readFileSync(filename).includes(Buffer.from(credentials.refreshToken)));
    assert.deepEqual(readCredentials(filename), credentials);
    saveCredentials({ ...credentials, calendarId: 'new-calendar' }, filename);
    assert.equal(readCredentials(filename).calendarId, 'new-calendar');
    assert.deepEqual(fs.readdirSync(dir), ['credentials.dpapi']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('setup requires confirmation before cloud mutations', async () => {
  let calls = 0;
  await assert.rejects(configureDestinations({}, async () => 'no', async () => { calls++; }, () => {}, () => {}), /Stopped/);
  assert.equal(calls, 0);
});
test('setup writes intent before creation and receipts afterward', async () => {
  const saved = {};
  const journal = [];
  const api = async (url, options = {}) => {
    if (url.includes('generateIds')) return { ids: ['generated-folder'] };
    if (options.method === 'POST' && url.includes('/drive/')) {
      assert.equal(journal.at(-1).setup.folderAttempted, true);
      assert.equal(JSON.parse(options.body).id, 'generated-folder');
      return { id: 'generated-folder' };
    }
    if (options.method === 'POST') {
      assert.equal(journal.at(-1).setup.calendarAttempted, true);
      return { id: 'calendar' };
    }
    if (url.includes('/drive/')) return { id: 'generated-folder', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } };
    return { id: 'calendar' };
  };
  await configureDestinations(saved, async () => 'CREATE', api, value => journal.push(structuredClone(value)), () => {});
  assert.equal(saved.rootFolderId, 'generated-folder');
  assert.equal(saved.calendarId, 'calendar');
});
test('ambiguous calendar creation never retries a POST', async () => {
  const saved = { ...credentials, rootFolderId: 'folder', setup: { calendarAttempted: true } };
  let calls = 0;
  await assert.rejects(configureDestinations(saved, async () => '', async () => { calls++; }, () => {}, () => {}), /manual reconciliation/);
  assert.equal(calls, 0);
});
test('setup API failure does not expose response body or token', async () => {
  const api = setupApi(async () => 'access-secret', async () => { throw new Error('access-secret'); });
  await assert.rejects(api('https://www.googleapis.com/drive/v3/files'), error => !error.message.includes('access-secret'));
});
