'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline/promises');
const { readCredentials, saveCredentials, createTokenProvider, createAuthorization, validState, PRIVATE_DIR } = require('./src/google-auth');

class SetupError extends Error {}
async function authorize(client, log = console.log, fetchImpl = fetch) {
  let finish;
  const callback = new Promise((resolve, reject) => { finish = { resolve, reject }; });
  // Register immediately so a browser denial cannot cause an unhandled rejection.
  callback.catch(() => {});
  let authorization, redirectUri, timer;
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    let received;
    try { received = new URL(req.url, redirectUri); } catch { res.writeHead(400).end('Invalid callback.'); return; }
    if (req.method !== 'GET' || received.pathname !== '/' || req.headers.host !== new URL(redirectUri).host) { res.writeHead(404).end('Not found.'); return; }
    if (!validState(received.searchParams.get('state'), authorization.state)) { res.writeHead(400).end('Invalid authorization state.'); return; }
    if (received.searchParams.has('error')) { res.writeHead(400).end('Google connection was not authorized. Return to the terminal.'); finish.reject(new SetupError('Google connection was not authorized.')); return; }
    const code = received.searchParams.get('code');
    if (!code) { res.writeHead(400).end('Missing authorization code.'); return; }
    res.end('Google authorization received. Return to the setup terminal to confirm destinations. You can close this tab.');
    finish.resolve(code);
  });
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    redirectUri = `http://127.0.0.1:${server.address().port}/`;
    authorization = createAuthorization(client.client_id, redirectUri);
    timer = setTimeout(() => finish.reject(new SetupError('Google sign-in timed out after five minutes. Run setup again.')), 5 * 60 * 1000);
    log('\nOpen this URL in your browser and sign in with the intended Google account:\n\n' + authorization.url + '\n');
    const code = await callback;
    const response = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'error', signal: AbortSignal.timeout(30000),
      body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, code, code_verifier: authorization.verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' })
    });
    if (!response.ok) throw new SetupError(`Google token exchange failed (HTTP ${Number(response.status) || 0}). Run setup again.`);
    const result = await response.json();
    if (typeof result.refresh_token !== 'string' || !result.refresh_token) throw new SetupError('Google did not return offline access. Revoke this app in your Google account and run setup again.');
    return { clientId: client.client_id, clientSecret: client.client_secret, refreshToken: result.refresh_token };
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  }
}

function setupApi(token, fetchImpl = fetch) {
  return async (url, options = {}) => {
    let response, accessToken;
    try { accessToken = await token(); }
    catch { throw new SetupError('Google authorization is unavailable. For expired or revoked consent, run setup-google.cmd --reconnect using the same Google account.'); }
    try {
      response = await fetchImpl(url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error', signal: AbortSignal.timeout(30000) });
    } catch { throw new SetupError('Google request did not complete. Setup progress was saved; run setup again.'); }
    if (!response.ok) throw new SetupError(`Google setup request failed (HTTP ${Number(response.status) || 0}). Check enabled APIs and account access, then run setup again.`);
    return response.json();
  };
}

async function configureDestinations(saved, ask, api, persist = saveCredentials, log = console.log) {
  saved.setup ||= {};
  const journal = saved.setup;
  // Drive permits a generated ID to be chosen before creation, so interrupted requests can be reconciled.
  if (!saved.rootFolderId) {
    if (!journal.folderId) {
      const answer = await ask('Create a private FDE folder in this Google account? Type CREATE to confirm (anything else stops): ');
      if (answer !== 'CREATE') throw new SetupError('Stopped without creating destinations. Run setup again when ready.');
      const ids = await api('https://www.googleapis.com/drive/v3/files/generateIds?count=1&space=drive&type=files');
      if (!ids.ids?.[0]) throw new SetupError('Google did not return a folder ID.');
      journal.folderId = ids.ids[0];
      journal.folderCreationAuthorized = true;
      persist(saved);
    }
    if (journal.folderAttempted) {
      // Never automatically POST after an uncertain outcome; GET either recovers it or stops.
      const folder = await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(journal.folderId)}?fields=id,mimeType,trashed,capabilities(canAddChildren)`);
      if (folder.mimeType !== 'application/vnd.google-apps.folder' || folder.trashed || !folder.capabilities?.canAddChildren) throw new SetupError('The saved setup folder is unavailable. Resolve it before continuing.');
      saved.rootFolderId = folder.id;
      persist(saved);
    } else {
      journal.folderAttempted = true;
      persist(saved);
      const folder = await api('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', body: JSON.stringify({ id: journal.folderId, name: 'FDE', mimeType: 'application/vnd.google-apps.folder' }) });
      if (folder.id !== journal.folderId) throw new SetupError('Google returned an unexpected folder ID. Setup requires inspection.');
      saved.rootFolderId = folder.id;
      persist(saved);
    }
  }
  if (!saved.calendarId) {
    if (journal.calendarAttempted) {
      log('A previous calendar creation attempt has no saved receipt. Setup will not create another calendar automatically.');
      const id = (await ask('Find FDE Deliveries in Google Calendar Settings > Integrate calendar. Paste its Calendar ID here, or leave blank to stop: ')).trim();
      if (!id || id === 'primary' || /\s/.test(id)) throw new SetupError('Calendar setup needs manual reconciliation. See GOOGLE_SETUP.md.');
      const calendar = await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}`);
      if (calendar.id !== id) throw new SetupError('Calendar could not be verified.');
      saved.calendarId = id;
      persist(saved);
    } else {
      const answer = await ask('Create a private FDE Deliveries calendar in this Google account? Type CREATE to confirm (anything else stops): ');
      if (answer !== 'CREATE') throw new SetupError('Stopped. The folder receipt is saved; run setup again to continue.');
      journal.calendarAttempted = true;
      persist(saved);
      const calendar = await api('https://www.googleapis.com/calendar/v3/calendars', { method: 'POST', body: JSON.stringify({ summary: 'FDE Deliveries', description: 'Approved project deadlines from FDE Meeting Review.', timeZone: 'Europe/Zurich' }) });
      if (!calendar.id) throw new SetupError('Google did not return a calendar receipt. Run setup again to reconcile.');
      saved.calendarId = calendar.id;
      persist(saved);
    }
  }
  const folder = await api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(saved.rootFolderId)}?fields=id,mimeType,trashed,capabilities(canAddChildren)`);
  if (folder.mimeType !== 'application/vnd.google-apps.folder' || folder.trashed || !folder.capabilities?.canAddChildren) throw new SetupError('Configured Drive folder is not writable.');
  const calendar = await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(saved.calendarId)}`);
  if (calendar.id !== saved.calendarId) throw new SetupError('Configured calendar is unavailable.');
  log('Google destinations verified. Restart FDE Meeting Review, then review and approve a non-sensitive sample before delivery.');
  return saved;
}

async function main() {
  if (process.platform !== 'win32') throw new SetupError('This setup uses Windows DPAPI. Run setup-google.cmd from Windows.');
  fs.mkdirSync(PRIVATE_DIR, { recursive: true });
  const lock = path.join(PRIVATE_DIR, 'google-setup.lock');
  let handle;
  try { handle = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(handle, String(process.pid)); }
  catch { throw new SetupError('Another setup may be running. Close it first. If none is running, remove data/private/google-setup.lock and retry.'); }
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async prompt => (await terminal.question(prompt)).trim();
  try {
    let saved = readCredentials();
    if (!(saved.clientId && saved.clientSecret && saved.refreshToken)) {
      const filename = (await ask('Path to the downloaded Desktop OAuth client JSON (kept on this computer, not in chat): ')).replace(/^"(.*)"$/, '$1');
      let client;
      try { client = JSON.parse(fs.readFileSync(filename, 'utf8')).installed; } catch { throw new SetupError('Could not read a valid Desktop OAuth client JSON.'); }
      if (!client || typeof client.client_id !== 'string' || typeof client.client_secret !== 'string' || !client.client_id || !client.client_secret) throw new SetupError('A Google Desktop app OAuth client JSON is required.');
      saved = await authorize(client);
      saveCredentials(saved);
      console.log('Google credentials saved with Windows encryption for your Windows account.');
    } else if (process.argv.includes('--reconnect')) {
      // Retain destination receipts: access validation will reject a different account instead of creating duplicates.
      Object.assign(saved, await authorize({ client_id: saved.clientId, client_secret: saved.clientSecret }));
      saveCredentials(saved);
    }
    await configureDestinations(saved, ask, setupApi(createTokenProvider(saved)));
  } finally {
    terminal.close();
    fs.closeSync(handle);
    fs.unlinkSync(lock);
  }
}

if (require.main === module) main().catch(error => { console.error(error instanceof SetupError ? error.message : 'Google setup could not complete. No credential details were logged. Check the local configuration and see GOOGLE_SETUP.md.'); process.exitCode = 1; });
module.exports = { authorize, configureDestinations, setupApi, SetupError };
