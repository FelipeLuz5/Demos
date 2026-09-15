'use strict';

const { sha, validDate } = require('./core');
const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';
const enc = encodeURIComponent;
const quoted = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

function briefDocument(project, artifact) {
  if (artifact?.approval?.passed !== true || !artifact.approval.approved_proposal_ids?.includes(project.id)) throw new Error('Recorded human approval is required');
  const paragraphs = [];
  const add = (text, style = 'NORMAL_TEXT') => paragraphs.push({ text: String(text), style });
  add(project.name, 'TITLE');
  add(`Client: ${project.client}`);
  add(`Delivery date: ${project.delivery_date || 'Unspecified'}`);
  add(project.description);
  for (const [title, items] of [['Deliverables', project.deliverables], ['Requirements', project.requirements]]) {
    if (!items?.length) continue;
    add(title, 'HEADING_1');
    for (const item of items) add(`• ${item.text}`);
  }
  const text = paragraphs.map(p => p.text + '\n').join('');
  // Docs drops these control characters on insert; reject instead of silently changing scope.
  if (/[\u0000-\u0008\u000c-\u001f\ue000-\uf8ff]/u.test(text) || text.length > 400000) throw new Error('Brief contains unsupported characters or exceeds Google delivery size');
  let index = 1;
  const requests = [{ insertText: { location: { index: 1 }, text } }];
  for (const p of paragraphs) {
    const endIndex = index + p.text.length + 1;
    requests.push({ updateParagraphStyle: { range: { startIndex: index, endIndex }, paragraphStyle: { namedStyleType: p.style }, fields: 'namedStyleType' } });
    index = endIndex;
  }
  return { text, requests, hash: sha(text) };
}

function calendarEvent(project, documentUrl, key) {
  if (!validDate(project.delivery_date)) throw new Error('Calendar deadline requires an agreed full date');
  const day = new Date(`${project.delivery_date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return {
    id: `fde${key}`, summary: `${project.client} — ${project.name}`,
    description: `Project delivery deadline\nApproved project brief: ${documentUrl}`,
    start: { date: project.delivery_date }, end: { date: day.toISOString().slice(0, 10) },
    transparency: 'transparent', reminders: { useDefault: false },
    extendedProperties: { private: { fdeKey: key } }
  };
}

function createGoogleClient(config, fetchImpl = fetch, tokenProvider) {
  const token = tokenProvider || require('./google-auth').createTokenProvider(config, fetchImpl);
  async function request(service, pathname, method = 'GET', body, allowMissing = false) {
    const bases = { drive: 'https://www.googleapis.com/drive/v3/', docs: 'https://docs.googleapis.com/v1/', calendar: 'https://www.googleapis.com/calendar/v3/' };
    const mutation = method !== 'GET';
    // Refresh failure happens before a mutation, so it is safe to retry after reconnecting.
    let accessToken;
    try { accessToken = await token(); } catch { const e = new Error('Google authorization failed. Reconnect the Google account.'); e.uncertain = false; throw e; }
    let response;
    try {
      response = await fetchImpl(bases[service] + pathname, {
        method, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(30000)
      });
    } catch { const e = new Error(mutation ? 'Google write outcome is uncertain. Check delivery before retrying.' : 'Google read failed or timed out.'); e.uncertain = mutation; throw e; }
    if (allowMissing && response.status === 404) return null;
    if (!response.ok) {
      const e = new Error(`Google ${service} request failed (HTTP ${response.status}).${response.status === 401 ? ' Reconnect the Google account.' : ''}`);
      e.uncertain = mutation && (response.status >= 500 || [408, 409].includes(response.status));
      throw e;
    }
    try { return await response.json(); } catch { const e = new Error('Google returned an unreadable response.'); e.uncertain = mutation; throw e; }
  }
  function receipt(file, kind, mutation = false) {
    if (!file?.id || file.mimeType !== (kind === 'folder' ? FOLDER : DOC) || file.trashed) {
      const e = new Error('Google returned an incomplete or invalid file receipt.'); e.uncertain = mutation; throw e;
    }
    return { id: file.id, url: kind === 'folder' ? `https://drive.google.com/drive/folders/${enc(file.id)}` : `https://docs.google.com/document/d/${enc(file.id)}/edit` };
  }
  const fields = 'id,name,mimeType,parents,trashed,appProperties,capabilities(canAddChildren,canEdit)';
  async function file(id) { return request('drive', `files/${enc(id)}?supportsAllDrives=true&fields=${enc(fields)}`); }
  async function findFile(parent, key, kind, name) {
    const mime = kind === 'folder' ? FOLDER : DOC;
    const q = `'${quoted(parent)}' in parents and trashed = false and mimeType = '${mime}' and ` +
      (kind === 'folder' ? `(name = '${quoted(name)}' or appProperties has { key='fdeKey' and value='${quoted(key)}' })` : `appProperties has { key='fdeKey' and value='${quoted(key)}' }`);
    const result = await request('drive', `files?${new URLSearchParams({ q, spaces: 'drive', pageSize: '100', fields: `files(${fields}),nextPageToken,incompleteSearch`, supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' })}`);
    if (!Array.isArray(result.files) || result.incompleteSearch || result.nextPageToken || result.files.length > 1) throw new Error('Google folder/document match is ambiguous. Resolve duplicate names or incomplete search before delivery.');
    if (!result.files.length) return null;
    const found = result.files[0];
    // Do not adopt an unrelated pre-existing folder just because its name matches.
    if (found.appProperties?.fdeKey !== key || (kind === 'folder' && found.name !== name)) throw new Error('Client folder identity changed or its name belongs to an unrelated folder. Reconcile before delivery.');
    if (!found.parents?.includes(parent)) throw new Error('Google file is outside the selected destination');
    return receipt(found, kind);
  }
  async function createFile(parent, key, kind, name) {
    return receipt(await request('drive', 'files?supportsAllDrives=true&fields=id,mimeType', 'POST', { name, mimeType: kind === 'folder' ? FOLDER : DOC, parents: [parent], appProperties: { fdeKey: key } }), kind, true);
  }
  async function verifyFile(id, parent, key, kind, name) {
    const found = await file(id);
    if (!found.parents?.includes(parent) || found.appProperties?.fdeKey !== key || (kind === 'folder' && found.name !== name)) throw new Error('Saved Google destination changed. Reconcile before delivery.');
    return receipt(found, kind);
  }
  async function readDocument(id) {
    const doc = await request('docs', `documents/${enc(id)}?includeTabsContent=true`);
    if (doc.documentId !== id || !doc.revisionId || doc.tabs?.length !== 1 || doc.tabs[0].childTabs?.length || !Array.isArray(doc.tabs[0].documentTab?.body?.content)) throw new Error('Google document could not be verified as a single project brief');
    const content = doc.tabs[0].documentTab.body.content;
    if (content.some(e => !e.paragraph && !e.sectionBreak) || content.some(e => e.paragraph?.elements?.some(p => !p.textRun))) throw new Error('Document contains unexpected content. Manual reconciliation required.');
    const text = content.map(e => (e.paragraph?.elements || []).map(p => p.textRun?.content || '').join('')).join('');
    return { text, revisionId: doc.revisionId };
  }
  return {
    async validate() {
      if (!config.configured) throw new Error('Connect Google and choose the Drive folder and calendar first');
      const root = await file(config.rootFolderId);
      if (root.mimeType !== FOLDER || root.trashed || root.capabilities?.canAddChildren !== true) throw new Error('Selected Google Drive folder is not writable');
      const cal = await request('calendar', `calendars/${enc(config.calendarId)}`);
      if (cal.id !== config.calendarId) throw new Error('Google Calendar destination could not be verified');
      return { folder: root.name, calendar: cal.summary };
    },
    findFolder: (parent, key, name) => findFile(parent, key, 'folder', name),
    createFolder: (parent, key, name) => createFile(parent, key, 'folder', name),
    verifyFolder: (id, parent, key, name) => verifyFile(id, parent, key, 'folder', name),
    findDocument: (parent, key) => findFile(parent, key, 'document'),
    createDocument: (parent, key, name) => createFile(parent, key, 'document', name),
    verifyDocument: (id, parent, key) => verifyFile(id, parent, key, 'document'),
    async fillDocument(id, content) {
      const before = await readDocument(id);
      if (before.text === content.text + '\n' || before.text === content.text) return;
      if (before.text !== '\n') throw new Error('Google Doc content differs from the approved brief. It was preserved; reconcile manually.');
      await request('docs', `documents/${enc(id)}:batchUpdate`, 'POST', { requests: content.requests, writeControl: { requiredRevisionId: before.revisionId } });
      const after = await readDocument(id);
      if (after.text !== content.text + '\n' && after.text !== content.text) { const e = new Error('Google Doc content verification failed.'); e.uncertain = true; throw e; }
    },
    async findEvent(key, expected) {
      const found = await request('calendar', `calendars/${enc(config.calendarId)}/events/${enc(expected.id)}`, 'GET', undefined, true);
      if (!found) return null;
      if (found.status === 'cancelled' || found.extendedProperties?.private?.fdeKey !== key || found.start?.date !== expected.start.date || found.end?.date !== expected.end.date || found.summary !== expected.summary || found.description !== expected.description || !found.htmlLink) throw new Error('Google Calendar event differs from the approved deadline. Reconcile manually.');
      return { id: found.id, url: found.htmlLink };
    },
    async createEvent(key, expected) {
      const found = await request('calendar', `calendars/${enc(config.calendarId)}/events?sendUpdates=none`, 'POST', expected);
      if (found.id !== expected.id || !found.htmlLink) { const e = new Error('Google returned an incomplete calendar receipt.'); e.uncertain = true; throw e; }
      const verified = await this.findEvent(key, expected);
      if (!verified) { const e = new Error('Created Google event could not be verified.'); e.uncertain = true; throw e; }
      return verified;
    }
  };
}

module.exports = { createGoogleClient, briefDocument, calendarEvent, FOLDER, DOC };
