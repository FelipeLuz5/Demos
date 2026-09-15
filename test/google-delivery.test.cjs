'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RunStore } = require('../src/db');
const { normalizeBrief, buildBriefReview, decideBrief } = require('../src/brief');
const { newRunRecord, artifactMarkdown } = require('../src/workflow');
const { deliverGoogle } = require('../src/google-delivery');
const { createApp } = require('../src/server');
const config = { configured: true, credentialsConfigured: true, rootFolderId: 'root', calendarId: 'calendar' };
function setup(t, dated = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-google-test-'));
  const filename = path.join(dir, 'test.sqlite');
  const store = new RunStore(filename);
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const source = normalizeBrief({ title: 'Serra website', started_at: '2026-09-14T10:00:00Z', reviewer: 'Felipe', transcript: 'Serra approves website delivery on 2026-10-23.' });
  const evidence = [{ line: 1, quote: source.transcript }];
  const extraction = { proposals: [{ name: 'Website', client: 'Serra', description: 'Website', deliverables: [{ text: 'Home', evidence }], requirements: [], delivery_date: dated ? '2026-10-23' : null, date_evidence: dated ? evidence : [], status: 'confirmed', evidence }] };
  const review = buildBriefReview(source, extraction);
  const run = store.create(newRunRecord(source, extraction, review));
  const decision = decideBrief(review, { decision: 'Approve projects', approvedProposalIds: [review.proposals[0].id], confirmEvidence: true });
  store.decide(run.id, decision.status, decision.decision, decision.artifact);
  const folders = new Map(), docs = new Map(), events = new Map();
  const counts = { folder: 0, doc: 0, event: 0, fill: 0 };
  const c = {
    validate: async () => {},
    findFolder: async (_parent, key) => folders.get(key) || null,
    createFolder: async (_parent, key) => { counts.folder++; const r = { id: 'folder', url: 'https://drive.google.com/drive/folders/folder' }; folders.set(key, r); return r; },
    verifyFolder: async () => ({ id: 'folder', url: 'https://drive.google.com/drive/folders/folder' }),
    findDocument: async (_parent, key) => docs.get(key) || null,
    createDocument: async (_parent, key) => { counts.doc++; const r = { id: 'doc', url: 'https://docs.google.com/document/d/doc/edit' }; docs.set(key, r); return r; },
    verifyDocument: async () => ({ id: 'doc', url: 'https://docs.google.com/document/d/doc/edit' }),
    fillDocument: async () => { counts.fill++; },
    findEvent: async key => events.get(key) || null,
    createEvent: async key => { counts.event++; const r = { id: 'event', url: 'https://calendar.google.com/calendar/event?eid=e' }; events.set(key, r); return r; }
  };
  return { store, run, c, counts, filename, events, folders, docs };
}

test('approved brief goes to Docs and Calendar once; receipts persist across restart', async t => {
  const s = setup(t);
  let r = await deliverGoogle(s.store, s.run.id, s.c, config);
  assert.equal(r.artifact.google_delivery.status, 'delivered');
  assert.equal(r.artifact.external_writes_performed, true);
  s.store.close();
  const reopened = new RunStore(s.filename);
  try { r = await deliverGoogle(reopened, s.run.id, s.c, config); } finally { reopened.close(); }
  assert.deepEqual([s.counts.folder, s.counts.doc, s.counts.event], [1, 1, 1]);
  assert.match(artifactMarkdown(r), /Google delivery/);
  assert.match(artifactMarkdown(r), /External writes performed: true/);
});

test('missing date creates only a Doc', async t => {
  const s = setup(t, false);
  const r = await deliverGoogle(s.store, s.run.id, s.c, config);
  assert.equal(r.artifact.google_delivery.projects[0].calendar_status, 'skipped');
  assert.equal(s.counts.event, 0);
});

test('crash before final receipt keeps destination pinned across restart and reconciles original resources', async t => {
  const s = setup(t);
  s.store.saveGoogleDelivery = () => { throw new Error('simulated process termination before final receipt'); };
  await assert.rejects(deliverGoogle(s.store, s.run.id, s.c, config), /simulated process termination/);
  assert.equal(s.store.get(s.run.id).artifact.google_delivery.status, 'in_progress');
  assert.equal(s.store.get(s.run.id).artifact.external_writes_performed, null);
  assert.equal(s.store.get(s.run.id).artifact.local_only, false);
  s.store.close();
  const reopened = new RunStore(s.filename);
  try {
    for (const changed of [{ ...config, calendarId: 'another-calendar' }, { ...config, rootFolderId: 'another-root' }]) {
      await assert.rejects(deliverGoogle(reopened, s.run.id, {}, changed), /destination changed/);
      assert.throws(() => reopened.beginGoogleDelivery(s.run.id, { root_folder_id: changed.rootFolderId, calendar_id: changed.calendarId }), /destination changed/);
    }
    const recovered = await deliverGoogle(reopened, s.run.id, s.c, config);
    assert.equal(recovered.artifact.google_delivery.status, 'delivered');
    assert.deepEqual([s.counts.folder, s.counts.doc, s.counts.event], [1, 1, 1]);
  } finally { reopened.close(); }
});

test('Calendar timeout preserves Doc and never blindly retries; discovered event recovers', async t => {
  const s = setup(t); let eventKey;
  s.c.createEvent = async key => { s.counts.event++; eventKey = key; throw new Error('timeout'); };
  let r = await deliverGoogle(s.store, s.run.id, s.c, config);
  assert.equal(r.artifact.google_delivery.status, 'uncertain');
  assert.ok(r.artifact.google_delivery.projects[0].document_url);
  await deliverGoogle(s.store, s.run.id, s.c, config);
  assert.equal(s.counts.event, 1);
  assert.equal(s.counts.doc, 1);
  s.events.set(eventKey, { id: 'event', url: 'https://calendar.google.com/calendar/event?eid=e' });
  r = await deliverGoogle(s.store, s.run.id, s.c, config);
  assert.equal(r.artifact.google_delivery.status, 'delivered');
});

test('uncertain client-folder creation is never replayed and clear rejection can retry', async t => {
  const s = setup(t);
  s.c.createFolder = async () => { s.counts.folder++; throw new Error('timeout'); };
  await deliverGoogle(s.store, s.run.id, s.c, config);
  await deliverGoogle(s.store, s.run.id, s.c, config);
  assert.equal(s.counts.folder, 1);
  assert.equal(s.counts.doc, 0);
  const s2 = setup(t);
  const create = s2.c.createEvent;
  s2.c.createEvent = async () => { const e = new Error('401'); e.uncertain = false; throw e; };
  assert.equal((await deliverGoogle(s2.store, s2.run.id, s2.c, config)).artifact.google_delivery.status, 'failed');
  s2.c.createEvent = create;
  assert.equal((await deliverGoogle(s2.store, s2.run.id, s2.c, config)).artifact.google_delivery.status, 'delivered');
  assert.equal(s2.counts.doc, 1);
});

test('tampering blocks all Google calls and historical Notion receipts are preserved', async t => {
  const s = setup(t);
  const record = s.store.get(s.run.id);
  record.artifact.delivery = { destination: 'notion', status: 'delivered', pages: [{ id: 'old' }] };
  s.store.db.prepare('UPDATE runs SET artifact_json=? WHERE id=?').run(JSON.stringify(record.artifact), s.run.id);
  const delivered = await deliverGoogle(s.store, s.run.id, s.c, config);
  assert.deepEqual(delivered.artifact.delivery, record.artifact.delivery);
  await assert.rejects(deliverGoogle(s.store, s.run.id, {}, { ...config, calendarId: 'other-calendar' }), /destination changed/);
  record.artifact.projects[0].name = 'Tampered';
  s.store.db.prepare('UPDATE runs SET artifact_json=? WHERE id=?').run(JSON.stringify(record.artifact), s.run.id);
  await assert.rejects(deliverGoogle(s.store, s.run.id, {}, config), /integrity/);
});

test('Google HTTP requires explicit send, session token, valid host; Notion writes are retired', async t => {
  const s = setup(t);
  const app = createApp({portfolio: false, store: s.store, googleConfig: { ...config, refreshToken: 'SECRET' }, googleClient: s.c });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const status = await fetch(base + '/api/google/status').then(r => r.text());
  assert.doesNotMatch(status, /SECRET|refreshToken/);
  const help = await fetch(base + '/google-setup.html').then(r => r.text());
  assert.match(help, /google-setup.css/);
  assert.doesNotMatch(help, /<style>/);
  assert.equal((await fetch(base + '/google-setup.css')).status, 200);
  const post = (suffix, body, headers = { 'X-CSRF-Token': app.csrf }) => fetch(`${base}/api/runs/${s.run.id}/${suffix}`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await post('google', { confirmDelivery: true }, {})).status, 403);
  assert.equal((await post('google', {})).status, 400);
  assert.equal((await post('notion', { confirmDelivery: true })).status, 410);
  const badHost = await new Promise((resolve, reject) => {
    const request = require('node:http').get(base, { headers: { Host: 'attacker.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal(s.counts.doc, 0);
  assert.equal((await post('google', { confirmDelivery: true })).status, 200);
  assert.equal(s.counts.doc, 1);
});
