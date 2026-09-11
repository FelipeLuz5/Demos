'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { baseConfig, fixtures } = require('../src/fixtures');

test('portfolio disables live extraction even with both permissions', async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fde-portfolio-'));
  const app = createApp({ database: path.join(folder, 'test.sqlite') });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); fs.rmSync(folder, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const bootstrap = await fetch(`${base}/api/bootstrap`).then(r => r.json());
  assert.equal(bootstrap.model.configured, false);
  const response = await fetch(`${base}/api/runs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': bootstrap.csrf },
    body: JSON.stringify({ mode: 'model', processingPermission: true, usagePermission: true,
      title: 'Fictional review', started_at: fixtures.pt05.source.started_at,
      transcript: fixtures.pt05.source.transcript, reviewer: 'Portfolio Reviewer',
      client: 'Northstar Studio', project: 'Autumn Launch', aliases: ['Autumn Launch'],
      owners: baseConfig.owners, approved_facts: 'Only Autumn Launch is approved.' })
  });
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /disabled in this portfolio demo/);
  assert.deepEqual((await fetch(`${base}/api/runs`).then(r => r.json())).runs, []);
});
