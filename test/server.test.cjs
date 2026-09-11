'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');

async function setup(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-workflow-'));
  let extractorCalls = 0;
  const app = createApp({ database: path.join(folder, 'test.sqlite'), extractor: async () => { extractorCalls++; throw new Error('Extractor should not be called'); } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const bootstrap = await fetch(`${base}/api/bootstrap`).then(response => response.json());
  return { base, bootstrap, csrf: bootstrap.csrf, extractorCalls: () => extractorCalls };
}

test('bootstrap identifies the configured OpenClaw ChatGPT OAuth route', async t => {
  const { bootstrap } = await setup(t);
  assert.equal(bootstrap.model.provider, 'OpenClaw · ChatGPT OAuth');
  assert.equal(bootstrap.model.name, 'openai/gpt-5.4-mini');
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
