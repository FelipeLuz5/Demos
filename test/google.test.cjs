'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createGoogleClient, briefDocument, calendarEvent, FOLDER, DOC } = require('../src/google');
const config = { configured: true, rootFolderId: 'root', calendarId: 'calendar@example.com' };
const project = { id: 'p1', name: 'Website', client: 'Serra', description: 'Approved scope 😀', delivery_date: '2028-02-29', deliverables: [{ text: 'Home page', evidence: [{ quote: 'private source quote' }] }], requirements: [] };
const artifact = { approval: { passed: true, approved_proposal_ids: ['p1'] } };
const ok = data => ({ ok: true, status: 200, json: async () => data });
function client(fetcher) { return createGoogleClient(config, fetcher, async () => 'test-token'); }

test('native document contains approved scope, full date and Unicode, excludes evidence/audit', () => {
  const doc = briefDocument(project, artifact);
  assert.match(doc.text, /Approved scope 😀/);
  assert.match(doc.text, /2028-02-29/);
  assert.doesNotMatch(doc.text, /private source quote|Requirements|approval/);
  assert.equal(doc.requests.at(-1).updateParagraphStyle.range.endIndex, doc.text.length + 1);
  assert.throws(() => briefDocument(project, { approval: { passed: false } }), /approval/);
  assert.throws(() => briefDocument({ ...project, description: '\u0000' }, artifact), /unsupported/);
});

test('deadline is all-day with exclusive next day, stable ID, no invitations or reminders', () => {
  const event = calendarEvent(project, 'https://docs.google.com/document/d/doc/edit', 'a'.repeat(64));
  assert.equal(event.end.date, '2028-03-01');
  assert.equal(event.start.date, '2028-02-29');
  assert.match(event.id, /^[a-v0-9]{5,1024}$/);
  assert.equal(event.attendees, undefined);
  assert.equal(event.transparency, 'transparent');
  assert.deepEqual(event.reminders, { useDefault: false });
  assert.throws(() => calendarEvent({ ...project, delivery_date: null }, '', 'key'), /agreed full date/);
});

test('Google requests are bounded, redact credential errors and do not retry writes', async () => {
  let calls = 0;
  const c = client(async (_url, options) => { calls++; assert.equal(options.redirect, 'error'); throw new Error('test-token'); });
  await assert.rejects(c.createDocument('folder', 'key', 'Website'), e => e.uncertain && !e.message.includes('test-token'));
  assert.equal(calls, 1);
  await assert.rejects(client(async () => ({ ok: false, status: 401 })).createFolder('root', 'key', 'Serra'), e => e.uncertain === false);
  await assert.rejects(client(async () => ok({})).createDocument('root', 'key', 'Website'), e => e.uncertain === true);
});

test('folder routing fails closed on unrelated same-name folders and duplicate matches', async () => {
  const folder = { id: 'f', name: 'Serra', mimeType: FOLDER, parents: ['root'], appProperties: { fdeKey: 'key' } };
  assert.equal((await client(async () => ok({ files: [folder] })).findFolder('root', 'key', 'Serra')).id, 'f');
  await assert.rejects(client(async () => ok({ files: [{ ...folder, appProperties: {} }] })).findFolder('root', 'key', 'Serra'), /identity/);
  await assert.rejects(client(async () => ok({ files: [folder, folder] })).findFolder('root', 'key', 'Serra'), /ambiguous/);
  await assert.rejects(client(async () => ok({ files: [folder], nextPageToken: 'next' })).findFolder('root', 'key', 'Serra'), /ambiguous/);
  await assert.rejects(client(async () => ok({ ...folder, parents: ['other'] })).verifyFolder('f', 'root', 'key', 'Serra'), /destination changed/);
});

test('Doc filling uses revision precondition and readback; exact retry does not append content', async () => {
  const content = briefDocument(project, artifact);
  let text = '\n'; let writes = 0;
  const c = client(async (url, options) => {
    if (options.method === 'POST') {
      writes++;
      const body = JSON.parse(options.body);
      assert.deepEqual(body.writeControl, { requiredRevisionId: 'r1' });
      text = body.requests[0].insertText.text + '\n';
      return ok({});
    }
    return ok({ documentId: 'doc', revisionId: 'r1', tabs: [{ documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: text } }] } }] } } }] });
  });
  await c.fillDocument('doc', content);
  await c.fillDocument('doc', content);
  assert.equal(writes, 1);
  text = 'Edited by someone\n';
  await assert.rejects(c.fillDocument('doc', content), /preserved/);
  assert.equal(writes, 1);
});

test('calendar event lookup rejects changed dates and insert suppresses notifications', async () => {
  const event = calendarEvent(project, 'https://docs.google.com/document/d/doc/edit', 'b'.repeat(64));
  const found = { ...event, htmlLink: 'https://calendar.google.com/calendar/event?eid=test' };
  const c = client(async (url, options) => {
    if (options.method === 'POST') assert.match(url, /sendUpdates=none$/);
    return ok(found);
  });
  assert.equal((await c.createEvent('b'.repeat(64), event)).id, event.id);
  await assert.rejects(client(async () => ok({ ...found, start: { date: '2028-03-01' } })).findEvent('b'.repeat(64), event), /differs/);
  assert.equal(await client(async () => ({ ok: false, status: 404 })).findEvent('key', event), null);
});
