'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveClientDestination, routeKey } = require('../src/notion-routing');
const config = { token: 'private-test-token', parentPageId: 'root' };
const page = (id, title) => ({ id, type: 'child_page', child_page: { title } });
const db = (id, title) => ({ id, type: 'child_database', child_database: { title } });
function fixture(root = [page('client', 'Aurora')], dbs = [db('db', 'Projects')], calendars = true) {
  const records = new Map(); const calls = [];
  const properties = { Name: { type: 'title', id: 'title' }, 'Delivery date': { type: 'date', id: 'date' }, 'FDE key': { type: 'rich_text', id: 'key' } };
  const store = { getRoute: key => records.get(key), saveRoute: (key, value) => records.set(key, structuredClone(value)) };
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); const path = parsed.pathname.replace('/v1/', '');
    calls.push({ path, method: options.method, body: options.body && JSON.parse(options.body), query: parsed.search });
    let result;
    if (options.method === 'POST') {
      if (path === 'pages') { root.push(page('client', 'Aurora')); result = { id: 'client' }; }
      if (path === 'databases') { dbs.push(db('db', 'Projects')); result = { id: 'db' }; }
      if (path === 'views') { calendars = true; result = { id: 'calendar' }; }
    } else if (path === 'blocks/root/children') result = { results: root, has_more: false };
    else if (path === 'blocks/client/children') result = { results: dbs, has_more: false };
    else if (path === 'databases/db') result = { id: 'db', data_sources: [{ id: 'source' }] };
    else if (path === 'data_sources/source') result = { properties };
    else if (path === 'views') result = { results: calendars ? [{ id: 'calendar' }] : [], has_more: false };
    else if (path === 'views/calendar') result = { id: 'calendar', type: 'calendar', data_source_id: 'source', configuration: { date_property_id: 'date' } };
    else throw new Error('Unexpected mock path');
    return { ok: true, json: async () => result };
  };
  return { store, fetchImpl, records, calls, root, properties };
}
test('reuses matching client page, database and calendar without writes', async () => {
  const f = fixture(); const route = await resolveClientDestination(f.store, config, '  AURORA ', f.fetchImpl);
  assert.equal(route.dataSourceId, 'source'); assert.equal(route.calendarViewId, 'calendar');
  assert.equal(f.calls.some(c => c.method !== 'GET'), false);
});

test('missing saved database cannot silently switch to a replacement', async () => {
  const f = fixture(undefined, [db('replacement', 'Projects')]);
  f.store.saveRoute(routeKey('root', 'Aurora'), { clientPageId: 'client', databaseId: 'db' });
  await assert.rejects(resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl), /no longer under/);
  assert.equal(f.calls.some(c => c.method !== 'GET'), false);
});

test('saved data source and client page cannot silently switch identities', async () => {
  for (const saved of [
    { clientPageId: 'client', databaseId: 'db', dataSourceId: 'old-source' },
    { clientPageId: 'old-client', databaseId: 'db' }
  ]) {
    const f = fixture();
    f.store.saveRoute(routeKey('root', 'Aurora'), saved);
    await assert.rejects(resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl), /has changed/);
    assert.equal(f.calls.some(c => c.method !== 'GET'), false);
    assert.deepEqual(f.store.getRoute(routeKey('root', 'Aurora')), saved);
  }
});
test('creates missing client structure then reuses it on repeat', async () => {
  const f = fixture([], [], false);
  const route = await resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl);
  assert.equal(route.structureCreated, true);
  assert.deepEqual(f.calls.filter(c => c.method === 'POST').map(c => c.path), ['pages', 'databases', 'views']);
  const payload = f.calls.find(c => c.path === 'views' && c.method === 'POST').body;
  assert.equal(payload.configuration.date_property_id, 'date');
  await resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl);
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 3);
});
test('rejects duplicate client pages and empty names before writes', async () => {
  const f = fixture([page('a', 'Aurora'), page('b', 'aurora')]);
  await assert.rejects(resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl), /Multiple client/);
  await assert.rejects(resolveClientDestination(f.store, config, ' ', f.fetchImpl), /confirmed client/);
  assert.equal(f.calls.some(c => c.method !== 'GET'), false);
});
test('uncertain page creation never blindly recreates; reconciles visible result', async () => {
  const f = fixture([], [], false);
  const fail = async (url, options) => { if (options.method === 'POST') throw new Error('private-test-token'); return f.fetchImpl(url, options); };
  await assert.rejects(resolveClientDestination(f.store, config, 'Aurora', fail), error => error.uncertain && !error.structureCreated && !error.message.includes(config.token));
  await assert.rejects(resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl), /uncertain/);
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
  f.root.push(page('client', 'Aurora'));
  const route = await resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl);
  assert.equal(route.databaseId, 'db');
});
test('uncertain calendar creation waits for reconciliation', async () => {
  const f = fixture(undefined, undefined, false);
  f.store.saveRoute(routeKey('root', 'Aurora'), { clientPageId: 'client', databaseId: 'db', pending: 'calendar' });
  await assert.rejects(resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl), /calendar creation is uncertain/);
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
});
test('uncertain database creation cannot recreate and definitive rejection can retry', async () => {
  const f = fixture(undefined, [], false);
  f.store.saveRoute(routeKey('root', 'Aurora'), { clientPageId: 'client', pending: 'database' });
  await assert.rejects(resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl), error => error.uncertain && /database creation is uncertain/.test(error.message));
  assert.equal(f.calls.some(c => c.method === 'POST'), false);
  const clean = fixture([], [], false);
  const denied = async (url, options) => options.method === 'POST' ? { ok: false, status: 403 } : clean.fetchImpl(url, options);
  await assert.rejects(resolveClientDestination(clean.store, config, 'Aurora', denied), error => !error.uncertain && !error.structureCreated);
  assert.equal(clean.store.getRoute(routeKey('root', 'Aurora')).pending, null);
  assert.equal((await resolveClientDestination(clean.store, config, 'Aurora', clean.fetchImpl)).databaseId, 'db');
});
test('search paginates completely and detects later duplicate', async () => {
  const f = fixture();
  const fetchImpl = async (url, options) => {
    if (url.includes('blocks/root/children')) return { ok: true, json: async () => url.includes('start_cursor=') ? { results: [page('other', 'Aurora')], has_more: false } : { results: [page('client', 'Aurora')], has_more: true, next_cursor: 'next' } };
    return f.fetchImpl(url, options);
  };
  await assert.rejects(resolveClientDestination(f.store, config, 'Aurora', fetchImpl), /Multiple client/);
});
test('reuses direct client database and refuses incompatible schema', async () => {
  const f = fixture([db('db', 'Aurora')]);
  const route = await resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl);
  assert.equal(route.clientPageId, null);
  f.properties['Delivery date'].type = 'rich_text';
  await assert.rejects(resolveClientDestination(f.store, config, 'Aurora', f.fetchImpl), /must have type date/);
});
