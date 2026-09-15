'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PRIVATE_DIR = path.resolve(__dirname, '../data/private');
const CREDENTIAL_FILE = path.join(PRIVATE_DIR, 'google-credentials.dpapi');
const SCOPES = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/calendar.app.created'];

// Fixed PowerShell program; credential bytes go through stdin, never argv or a shell expression.
function dpapi(input, decrypt = false) {
  if (process.platform !== 'win32') throw new Error('Google credential storage requires Windows; use explicit environment configuration on other systems.');
  const operation = decrypt ? 'Unprotect' : 'Protect';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[System.Security.Cryptography.ProtectedData]::${operation}($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    input: Buffer.from(input).toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024
  });
  if (result.error || result.status !== 0 || !result.stdout?.trim()) throw new Error('Cannot access Windows-protected Google credentials. Run setup under the same Windows user.');
  return Buffer.from(result.stdout.trim(), 'base64');
}

function readCredentials(filename = CREDENTIAL_FILE) {
  if (!fs.existsSync(filename)) return {};
  try { return JSON.parse(dpapi(fs.readFileSync(filename), true).toString('utf8')); }
  catch { throw new Error('Cannot read Windows-protected Google credentials. Run setup under the same Windows user.'); }
}

function saveCredentials(value, filename = CREDENTIAL_FILE) {
  const encrypted = dpapi(Buffer.from(JSON.stringify(value)));
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, encrypted, { flag: 'wx', mode: 0o600 });
    if (fs.existsSync(filename)) fs.renameSync(temp, filename);
    else { fs.linkSync(temp, filename); fs.unlinkSync(temp); }
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function googleConfig(env = process.env, read = readCredentials) {
  const names = { clientId: 'GOOGLE_CLIENT_ID', clientSecret: 'GOOGLE_CLIENT_SECRET', refreshToken: 'GOOGLE_REFRESH_TOKEN', rootFolderId: 'GOOGLE_DRIVE_ROOT_FOLDER_ID', calendarId: 'GOOGLE_CALENDAR_ID' };
  let saved = {}, error;
  // A complete environment config remains usable even when a DPAPI file belongs to another account.
  if (!Object.values(names).every(name => String(env[name] || '').trim())) {
    try { saved = read(); } catch { error = 'Stored Google credentials are unavailable. Run setup under the same Windows user.'; }
  }
  const config = {};
  for (const [key, name] of Object.entries(names)) config[key] = String(env[name] === undefined ? saved[key] || '' : env[name]).trim();
  config.credentialsConfigured = Boolean(config.clientId && config.clientSecret && config.refreshToken);
  config.configured = Boolean(config.credentialsConfigured && config.rootFolderId && config.calendarId);
  if (error) config.error = error;
  return config;
}

function createTokenProvider(config, fetchImpl = fetch) {
  let cached, expiresAt = 0, pending;
  async function refresh() {
    if (!(config.clientId && config.clientSecret && config.refreshToken)) throw new Error('Google credentials are not configured. Run setup-google.cmd.');
    let response;
    try {
      response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken, grant_type: 'refresh_token' }),
        redirect: 'error', signal: AbortSignal.timeout(30000)
      });
    } catch { throw new Error('Google authorization is temporarily unavailable. Retry later.'); }
    if (!response.ok) throw new Error(response.status === 400 || response.status === 401 ? 'Google authorization expired or was revoked. Run setup-google.cmd --reconnect.' : `Google authorization failed (HTTP ${Number(response.status) || 0}).`);
    let data;
    try { data = await response.json(); } catch { throw new Error('Google returned an invalid authorization response.'); }
    if (typeof data.access_token !== 'string' || !data.access_token) throw new Error('Google returned an invalid authorization response.');
    cached = data.access_token;
    expiresAt = Date.now() + Math.max(0, (Number(data.expires_in) || 0) - 60) * 1000;
    return cached;
  }
  return async function accessToken() {
    if (cached && Date.now() < expiresAt) return cached;
    if (!pending) pending = refresh().finally(() => { pending = undefined; });
    return pending;
  };
}

function createAuthorization(clientId, redirectUri) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const state = crypto.randomBytes(32).toString('base64url');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  return { verifier, state, url: url.toString() };
}

function validState(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

module.exports = { googleConfig, createTokenProvider, readCredentials, saveCredentials, createAuthorization, validState, CREDENTIAL_FILE, PRIVATE_DIR, SCOPES };
