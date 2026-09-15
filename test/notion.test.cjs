const test = require('node:test');
const assert = require('node:assert/strict');
const { notionConfig, createNotionClient, pagePayload } = require('../src/notion');
const config = notionConfig({ NOTION_TOKEN: 'secret-test-only', NOTION_DATA_SOURCE_ID: 'source-id' });
const project = { id: 'p1', name: 'Website', client: 'Aurora', description: 'Client website', delivery_date: null, status: 'confirmed', deliverables: [{ text: 'Home page', evidence: [{ line: 1, quote: 'A home page' }] }], requirements: [], evidence: [], date_evidence: [] };
const artifact = { meeting: { title: 'Client meeting', started_at: '2026-09-11', source_hash: 'hash' }, approval: { passed: true, approved_proposal_ids: ['p1'], reviewer: 'Felipe', at: '2026-09-11', review_id: 'r1' } };
const response = data => ({ ok: true, json: async () => data });

test('Notion maps a concise approved brief without evidence or audit text', async () => {
  let payload;
  const client = createNotionClient(config, async (url, options) => {
    assert.equal(url, 'https://api.notion.com/v1/pages');
    assert.equal(options.headers['Notion-Version'], '2025-09-03');
    assert.equal(options.redirect, 'error');
    payload = JSON.parse(options.body);
    return response({ id: 'page', url: 'https://www.notion.so/page' });
  });
  assert.deepEqual(await client.create(project, artifact, 'key'), { id: 'page', url: 'https://www.notion.so/page' });
  assert.equal(payload.parent.data_source_id, 'source-id');
  assert.equal(payload.properties.Name.title[0].text.content, 'Website');
  assert.equal(payload.properties['Delivery date'].date, null);
  assert.equal(payload.properties['FDE key'].rich_text[0].text.content, 'key');
  assert.match(JSON.stringify(payload.children), /Home page/);
  assert.doesNotMatch(JSON.stringify(payload.children), /Line 1|A home page|Approved by|Source and approval|evidence/);
  assert.equal(project.deliverables[0].evidence[0].quote, 'A home page');
  assert.deepEqual(pagePayload(config, { ...project, delivery_date: '2026-10-30' }, artifact, 'key').properties['Delivery date'], { date: { start: '2026-10-30' } });
});

test('Notion checks schema without mutation, queries key and detects duplicates', async () => {
  const client = createNotionClient(config, async (url, options) => {
    if (options.method === 'GET') return response({ properties: { Name: { type: 'title' }, 'Delivery date': { type: 'date' }, 'FDE key': { type: 'rich_text' } } });
    assert.match(url, /data_sources\/source-id\/query$/);
    assert.deepEqual(JSON.parse(options.body).filter, { property: 'FDE key', rich_text: { equals: 'key' } });
    return response({ results: [], has_more: false });
  });
  assert.equal((await client.validate()).valid, true);
  assert.equal(await client.find('key'), null);
  await assert.rejects(createNotionClient(config, async () => response({ properties: {} })).validate(), /requires property/);
  await assert.rejects(createNotionClient(config, async () => response({ results: [{ id: 'a' }, { id: 'b' }] })).find('key'), /Multiple Notion/);
});

test('Notion bounds content and requires approval before attempting a write', async () => {
  let calls = 0;
  const client = createNotionClient(config, async () => { calls++; return response({}); });
  await assert.rejects(client.create(project, { ...artifact, approval: { passed: false } }, 'key'), /approval/);
  await assert.rejects(client.create({ ...project, requirements: Array.from({ length: 101 }, () => ({ text: 'x', evidence: [] })) }, artifact, 'key'), /100 content blocks/);
  assert.equal(calls, 0);
  const payload = pagePayload(config, { ...project, description: '😀'.repeat(2001) }, artifact, 'key');
  assert.equal(payload.children[1].paragraph.rich_text.map(t => t.text.content).join(''), '😀'.repeat(2001));
  assert.ok(payload.children[1].paragraph.rich_text.every(t => t.text.content.length <= 2000));
});

test('Notion never blindly retries uncertain writes or exposes credential in errors', async () => {
  let calls = 0;
  const client = createNotionClient(config, async () => { calls++; throw new Error(config.token); });
  await assert.rejects(client.create(project, artifact, 'key'), e => e.uncertain === true && !e.message.includes(config.token));
  assert.equal(calls, 1);
  await assert.rejects(createNotionClient(config, async () => ({ ok: false, status: 503 })).create(project, artifact, 'key'), e => e.uncertain === true);
  await assert.rejects(createNotionClient(config, async () => ({ ok: false, status: 401 })).create(project, artifact, 'key'), e => e.uncertain === false);
  await assert.rejects(createNotionClient(config, async () => response({})).create(project, artifact, 'key'), e => e.uncertain === true);
  assert.equal(notionConfig({}).configured, false);
});
