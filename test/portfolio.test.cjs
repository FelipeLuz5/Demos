'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/server');

async function setup(t) {
  let externalCalls = 0;
  const unexpected = () => { externalCalls++; throw new Error('External dependency must not run'); };
  const app = createApp({ database: ':memory:', extractor: unexpected, briefExtractor: unexpected, draftRefiner: unexpected,
    googleConfig: { configured: true, clientId: 'sentinel', refreshToken: 'sentinel', rootFolderId: 'sentinel', calendarId: 'sentinel' },
    googleClient: new Proxy({}, { get: unexpected }), fathom: new Proxy({}, { get: unexpected }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, body, token = app.csrf) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body) });
  return { app, base, post, calls: () => externalCalls };
}

test('offline default ignores injected configured connections and blocks all external HTTP actions', async t => {
  const { app, base, post, calls } = await setup(t);
  const bootstrap = await fetch(base + '/api/bootstrap').then(r => r.json());
  assert.equal(bootstrap.portfolio, true);
  assert.equal(bootstrap.model.configured, false);
  assert.equal(bootstrap.demoFixtures.length, 3);
  for (const provider of ['google', 'fathom']) {
    const status = await fetch(`${base}/api/${provider}/status`).then(r => r.json());
    assert.equal(status.configured, false);
    assert.ok(!JSON.stringify(status).includes('sentinel'));
  }
  for (const mode of ['model', 'brief', 'fixture']) {
    assert.equal((await post('/api/runs', { mode, processingPermission: true, usagePermission: true })).status, 403);
  }
  for (const route of ['/api/fathom/connect', '/api/fathom/meetings', '/api/fathom/import', '/api/runs/abcdef/google', '/api/runs/abcdef/notion', '/api/runs/abcdef/draft']) {
    assert.equal((await post(route, { confirmDelivery: true, processingPermission: true, usagePermission: true })).status, 403);
  }
  assert.equal((await fetch(base + '/google-setup.html')).status, 403);
  assert.deepEqual(app.store.list(), []);
  assert.equal(calls(), 0);
});

test('recruiter journey validates, selects one project, saves the decision and exports only approved scope', async t => {
  const { app, base, post, calls } = await setup(t);
  const input = { mode: 'demo', fixture: 'website-and-catalogue', reviewer: 'Alex Reviewer' };
  assert.equal((await post('/api/runs', input, 'invalid')).status, 403);
  const response = await post('/api/runs', input);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.review.kind, 'client_briefs');
  assert.deepEqual(created.review.proposals.map(p => p.status), ['confirmed', 'needs_decision']);
  const approve = { decision: 'Approve projects', approvedProposalIds: [created.review.proposals[0].id], confirmEvidence: true };
  const saved = await (await post(`/api/runs/${created.id}/decision`, approve)).json();
  assert.equal(saved.status, 'approved');
  assert.equal(saved.artifact.approval.reviewer, 'Alex Reviewer');
  assert.equal(saved.artifact.projects.length, 1);
  assert.equal(saved.artifact.projects[0].delivery_date, '2026-10-23');
  assert.equal(saved.artifact.external_writes_performed, false);
  assert.equal(app.store.get(created.id).status, 'approved');
  const md = await fetch(`${base}/api/runs/${created.id}/export?format=markdown`).then(r => r.text());
  assert.match(md, /Northstar website/);
  assert.doesNotMatch(md, /## Winter catalogue/);
  const json = await fetch(`${base}/api/runs/${created.id}/export`).then(r => r.json());
  assert.equal(json.projects.length, 1);
  assert.equal((await post(`/api/runs/${created.id}/decision`, approve)).status, 409);
  assert.equal(calls(), 0);
});

test('unsupported evidence saves no review; an undated brief stays undated and may be rejected', async t => {
  const { app, post } = await setup(t);
  const bad = await post('/api/runs', { mode: 'demo', fixture: 'invalid-evidence', reviewer: 'Alex' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /exact transcript quotation/);
  assert.deepEqual(app.store.list(), []);
  const created = await (await post('/api/runs', { mode: 'demo', fixture: 'portuguese-undated', reviewer: 'Alex' })).json();
  assert.equal(created.review.proposals[0].delivery_date, null);
  const saved = await (await post(`/api/runs/${created.id}/decision`, { decision: 'Reject' })).json();
  assert.equal(saved.status, 'rejected');
  assert.equal(saved.artifact, null);
});
