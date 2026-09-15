'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function ui() {
  const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')
    .replace(/init\(\)\.catch\(error => toast\(error\.message\)\);\s*$/, '');
  const element = { addEventListener() {} };
  const context = vm.createContext({ document: { querySelector: () => element }, URL, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  vm.runInContext("state.google = {configured:true,rootFolderId:'folder123',calendarId:'calendar@example.com'}", context);
  return {
    context,
    render(record) { context.record = record; return vm.runInContext('googleDelivery(record)', context); },
    history(record) { context.record = record; return vm.runInContext('historicalNotionDelivery(record)', context); }
  };
}

function approved(delivery) {
  return { artifact: { projects: [{ id: 'p' }], ...(delivery ? { google_delivery: delivery } : {}) }, decision: { approval: { passed: true } } };
}

test('Google sends require approval and an explicit action with destinations visible', () => {
  const app = ui();
  const html = app.render(approved());
  assert.match(html, /Send approved projects to Google/);
  assert.match(html, /folder123/);
  assert.match(html, /calendar@example.com/);
  assert.match(html, /all-day/);
  assert.match(html, /No invitations/);
  assert.equal(app.render({ artifact: { projects: [{ id: 'p' }] } }), '');
});

test('historical Notion receipts stay read-only and Google copies require a separate action', () => {
  const app = ui();
  const record = approved();
  record.artifact.delivery = { destination: 'notion', status: 'delivered', pages: [{ project: 'Old brief', url: 'https://notion.so/old' }] };
  assert.match(app.render(record), /Create Google copies of these approved projects/);
  const history = app.history(record);
  assert.match(history, /read-only/);
  assert.match(history, /https:\/\/notion.so\/old/);
  assert.doesNotMatch(history, /<button/);
});

test('default delivery metadata does not create a historical Notion receipt', () => {
  const app = ui();
  const record = approved();
  record.artifact.delivery = { status: 'not_configured', destination: null };
  assert.equal(app.history(record), '');
  assert.match(app.render(record), /Send approved projects to Google/);
  assert.doesNotMatch(app.render(record), /Create Google copies/);
});

test('changed folder or calendar blocks reconciliation until original connection is restored', () => {
  const app = ui();
  for (const changed of [{ root_folder_id: 'old-folder' }, { calendar_id: 'old-calendar' }]) {
    const html = app.render(approved({ status: 'uncertain', root_folder_id: 'folder123', calendar_id: 'calendar@example.com', ...changed }));
    assert.match(html, /Google destination changed\. Restore the original connection to reconcile this delivery\./);
    assert.doesNotMatch(html, /id="google-delivery"/);
    assert.ok(html.includes(Object.values(changed)[0]));
  }
  const restored = app.render(approved({ status: 'uncertain', root_folder_id: 'folder123', calendar_id: 'calendar@example.com' }));
  assert.match(restored, />Check Google delivery<\/button>/);
  assert.doesNotMatch(restored, /Google destination changed/);
});

test('uncertain receipt offers explicit reconciliation and completed receipt offers no send', () => {
  const app = ui();
  const html = app.render(approved({ status: 'uncertain' }));
  assert.match(html, /id="google-delivery"/);
  assert.match(html, />Check Google delivery<\/button>/);
  assert.match(html, /remaining delivery stages may then complete/);
  assert.match(html, /will not be recreated/);
  assert.doesNotMatch(app.render(approved({ status: 'delivered' })), /id="google-delivery"/);
});

test('receipt links require HTTPS and exact Google hosts and text is escaped', () => {
  const app = ui();
  const html = app.render(approved({ status: 'delivered', projects: [{
    project: '<script>', folder_url: 'https://drive.google.com.evil.test/x',
    document_url: 'https://docs.google.com/document/d/x', calendar_url: 'javascript:alert(1)', calendar_status: 'skipped'
  }] }));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /https:\/\/docs.google.com\/document\/d\/x/);
  assert.match(html, /No agreed date/);
  assert.doesNotMatch(html, /evil.test|javascript:|<script>/);
  for (const url of ['http://docs.google.com/x', 'https://user:pass@docs.google.com/x', 'https://docs.google.com:444/x']) {
    app.context.url = url;
    assert.equal(vm.runInContext("googleLink(url, 'Brief', ['docs.google.com'])", app.context), '');
  }
});

test('unconfigured or unavailable Google status shows setup without send', () => {
  const app = ui();
  for (const status of [null, { configured: false }]) {
    app.context.googleStatus = status;
    vm.runInContext('state.google = googleStatus', app.context);
    const html = app.render(approved());
    assert.match(html, /\/google-setup.html/);
    assert.doesNotMatch(html, /id="google-delivery"/);
  }
});
