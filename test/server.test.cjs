'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

async function setup(t, options = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-workflow-'));
  let extractorCalls = 0;
  const app = createApp({portfolio: false, googleConfig: {configured:false}, database: path.join(folder, 'test.sqlite'), extractor: async () => { extractorCalls++; throw new Error('Extractor should not be called'); }, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const bootstrap = await fetch(`${base}/api/bootstrap`).then(response => response.json());
  return { base, bootstrap, csrf: bootstrap.csrf, extractorCalls: () => extractorCalls };
}

test('bootstrap identifies the configured OpenClaw ChatGPT OAuth route', async t => {
  const { bootstrap } = await setup(t);
  assert.equal(bootstrap.model.provider, 'OpenClaw / ChatGPT OAuth');
  assert.equal(bootstrap.model.name, 'openai/gpt-5.6-sol');
  assert.equal(bootstrap.model.thinking, 'low');
});

test('browser route serves the local application with security headers', async t => {
  const { base } = await setup(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  const html = await response.text();
  assert.match(html, /FDE Meeting Review/);
  assert.match(html, /<script src="\/consent\.js" defer><\/script>\s*<script src="\/app\.js" defer><\/script>/);
  assert.equal((await fetch(`${base}/consent.js`)).status, 200);
});

test('fixture run, approval, persistence, and exports work through HTTP', async t => {
  const { base, csrf } = await setup(t);
  const createdResponse = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ mode: 'fixture', fixture: 'pt05' }) });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.status, 'review');
  const decisionResponse = await fetch(`${base}/api/runs/${created.id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ decision: 'Approve', confirmEvidence: true }) });
  assert.equal(decisionResponse.status, 200);
  const decided = await decisionResponse.json();
  assert.equal(decided.status, 'approved');
  assert.equal(decided.artifact.tasks.length, 1);
  const list = await fetch(`${base}/api/runs`).then(response => response.json());
  assert.equal(list.runs[0].status, 'approved');
  const markdown = await fetch(`${base}/api/runs/${created.id}/export?format=markdown`).then(response => response.text());
  assert.match(markdown, /Approved tasks/);
  assert.match(markdown, /External writes performed: false/);
});

test('mutations require the browser session token', async t => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'fixture', fixture: 'pt05' }) });
  assert.equal(response.status, 403);
});

test('manual transcript cannot trigger a subscription model call without both confirmations', async t => {
  const { base, csrf, extractorCalls } = await setup(t);
  const response = await fetch(`${base}/api/runs`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ mode: 'model', processingPermission: false, usagePermission: false }) });
  assert.equal(response.status, 400);
  assert.equal(extractorCalls(), 0);
});

test('a saved review accepts only one final decision', async t => {
  const { base, csrf } = await setup(t);
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const created = await fetch(`${base}/api/runs`, { method: 'POST', headers, body: JSON.stringify({ mode: 'fixture', fixture: 'pt05' }) }).then(response => response.json());
  const body = JSON.stringify({ decision: 'Reject', confirmEvidence: false });
  assert.equal((await fetch(`${base}/api/runs/${created.id}/decision`, { method: 'POST', headers, body })).status, 200);
  assert.equal((await fetch(`${base}/api/runs/${created.id}/decision`, { method: 'POST', headers, body })).status, 409);
});

test('partial review and draft refinement persist through HTTP with fresh consent', async t => {
  let calls = 0;
  const { base, csrf } = await setup(t, { draftRefiner: async () => { calls++; return { subject: 'Pergunta', body: 'Qual é o prazo?', status: 'draft', method: 'model', recipient: '' }; } });
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const post = (url, data) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(data) });
  const created = await (await post('/api/runs', { mode: 'fixture', fixture: 'full' })).json();
  const response = await post(`/api/runs/${created.id}/decision`, { decision: 'Review tasks', confirmEvidence: true, approvedTaskKeys: [created.review.candidates[0].task_key], clarifications: [{ index: 0, comment: 'Qual é o prazo?' }] });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.artifact.tasks.length, 1);
  assert.equal(saved.artifact.pending_tasks.length, 1);
  assert.equal(saved.artifact.email_draft.method, 'template');
  assert.equal((await post(`/api/runs/${created.id}/draft`, {})).status, 400);
  assert.equal(calls, 0);
  assert.equal((await post(`/api/runs/${created.id}/draft`, { processingPermission: true, usagePermission: true })).status, 200);
  const reloaded = await fetch(`${base}/api/runs/${created.id}`).then(r => r.json());
  assert.equal(reloaded.artifact.email_draft.method, 'model');
  assert.equal(reloaded.artifact.tasks.length, 1);
  assert.equal(calls, 1);
});

test('client brief intake needs no internal owners and approvals export only selected projects', async t => {
  let calls = 0;
  const quote = 'Acme client: We approve the website.';
  const { base, csrf } = await setup(t, { briefExtractor: async () => {
    calls++;
    return { proposals: [{ name: 'Website', client: 'Acme', description: 'Website', deliverables: [{ text: 'Website', evidence: [{ line: 1, quote }] }], requirements: [], delivery_date: null, date_evidence: [], status: 'confirmed', evidence: [{ line: 1, quote }] }] };
  } });
  const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf };
  const post = (url, data) => fetch(`${base}${url}`, { method: 'POST', headers, body: JSON.stringify(data) });
  const data = { mode: 'brief', title: 'Website meeting', started_at: '2026-09-11T10:00:00+02:00', reviewer: 'Felipe', client: 'Acme', transcript: quote };
  assert.equal((await post('/api/runs', data)).status, 400);
  assert.equal(calls, 0);
  const response = await post('/api/runs', { ...data, processingPermission: true, usagePermission: true });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.review.kind, 'client_briefs');
  const decision = await post(`/api/runs/${created.id}/decision`, { decision: 'Approve projects', approvedProposalIds: [created.review.proposals[0].id], confirmEvidence: true });
  assert.equal(decision.status, 200);
  const saved = await decision.json();
  assert.equal(saved.artifact.projects.length, 1);
  assert.equal(saved.artifact.projects[0].delivery_date, null);
  assert.equal(saved.artifact.tasks, undefined);
  const md = await fetch(`${base}/api/runs/${created.id}/export?format=markdown`).then(r => r.text());
  assert.match(md, /Delivery date: Unspecified/);
  assert.equal((await post(`/api/runs/${created.id}/decision`, { decision: 'Reject' })).status, 409);
});
