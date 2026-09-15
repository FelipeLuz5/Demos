'use strict';

const { createHash } = require('node:crypto');
const normalize = value => String(value || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const routeKey = (parent, client) => createHash('sha256').update(`${String(parent).replace(/-/g, '').toLowerCase()}\n${normalize(client)}`).digest('hex');
const text = value => [{ type: 'text', text: { content: value } }];
const schema = { Name: { title: {} }, 'Delivery date': { date: {} }, 'FDE key': { rich_text: {} } };

async function resolveClientDestination(store, config, clientName, fetchImpl = fetch) {
  if (typeof clientName !== 'string' || !normalize(clientName) || clientName.length > 2000) throw new Error('A confirmed client name is required for Notion routing');
  if (!config.parentPageId || !config.token) throw new Error('Configure the Notion parent page and token first');
  const key = routeKey(config.parentPageId, clientName);
  let state = store.getRoute(key) || {};
  let structureCreated = false;
  const save = patch => { state = { ...state, ...patch }; store.saveRoute(key, state); };
  async function request(path, method = 'GET', body) {
    let response;
    try {
      response = await fetchImpl(`https://api.notion.com/v1/${path}`, {
        method, headers: { Authorization: `Bearer ${config.token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000), redirect: 'error'
      });
    } catch { throw new Error('Notion routing request failed or timed out; retry to reconcile its outcome'); }
    if (!response.ok) {
      const error = new Error(`Notion routing request failed (HTTP ${response.status}); retry to reconcile its outcome`);
      error.definitive = response.status >= 400 && response.status < 500 && response.status !== 408;
      throw error;
    }
    try { return await response.json(); } catch { throw new Error('Notion routing returned an unreadable response; reconciliation required'); }
  }
  async function list(path) {
    const result = []; let cursor; const seen = new Set();
    do {
      const page = await request(`${path}${path.includes('?') ? '&' : '?'}page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!Array.isArray(page.results)) throw new Error('Notion routing returned an invalid list');
      result.push(...page.results.filter(item => !item.archived && !item.in_trash));
      cursor = page.has_more ? page.next_cursor : null;
      if (page.has_more && (!cursor || seen.has(cursor))) throw new Error('Notion routing pagination could not be completed');
      seen.add(cursor);
    } while (cursor);
    return result;
  }
  const children = id => list(`blocks/${encodeURIComponent(id)}/children`);
  function unique(items, label) {
    if (items.length > 1) throw new Error(`Multiple ${label} match this client; choose the destination before sending`);
    return items[0];
  }
  function uncertain(stage) {
    if (state.pending === stage) throw new Error(`Previous Notion ${stage} creation is uncertain and no matching object is visible; manual reconciliation required`);
  }
  async function create(stage, path, payload) {
    save({ pending: stage }); // Durable intent before any external mutation.
    let result;
    try { result = await request(path, 'POST', payload); }
    catch (error) { if (error.definitive) save({ pending: null }); throw error; }
    structureCreated = true;
    if (!result.id) throw new Error(`Notion ${stage} creation returned no ID; reconciliation required`);
    return result;
  }
  try {
  const root = await children(config.parentPageId);
  const match = unique(root.filter(block => {
    const title = block.child_page?.title ?? block.child_database?.title;
    return title !== undefined && (normalize(title) === normalize(clientName) || block.id === state.clientPageId || block.id === state.databaseId);
  }), 'client pages or databases');
  if (!match && (state.clientPageId || state.databaseId)) throw new Error('Saved Notion client destination is no longer under the configured parent');
  if (state.clientPageId && match?.id !== state.clientPageId) throw new Error('Saved Notion client page has changed; reconcile the destination before sending');
  if (!state.clientPageId && state.databaseId && match?.id !== state.databaseId) throw new Error('Saved Notion client database has changed; reconcile the destination before sending');
  let clientPageId = match?.type === 'child_page' ? match.id : null;
  let databaseId = match?.type === 'child_database' ? match.id : null;
  if (!match) {
    uncertain('page');
    const page = await create('page', 'pages', { parent: { type: 'page_id', page_id: config.parentPageId }, properties: { title: { title: text(clientName.trim()) } } });
    clientPageId = page.id;
    save({ clientPageId, pending: null });
  } else if (state.pending === 'page') save({ clientPageId, pending: null });
  if (!databaseId) {
    const databases = (await children(clientPageId)).filter(block => block.type === 'child_database');
    if (state.databaseId && !databases.some(block => block.id === state.databaseId)) throw new Error('Saved Notion project database is no longer under the client page');
    const named = databases.filter(block => normalize(block.child_database?.title) === 'projects' || block.id === state.databaseId);
    const db = unique(named.length ? named : databases, 'project databases');
    if (db) databaseId = db.id;
    else {
      if (state.databaseId) throw new Error('Saved Notion project database is no longer under the client page');
      uncertain('database');
      const created = await create('database', 'databases', { parent: { type: 'page_id', page_id: clientPageId }, title: text('Projects'), is_inline: true, initial_data_source: { properties: schema } });
      databaseId = created.id;
    }
  }
  const database = await request(`databases/${encodeURIComponent(databaseId)}`);
  if (database.archived || database.in_trash || database.data_sources?.length !== 1) throw new Error('Notion client database must have exactly one active data source');
  const dataSourceId = database.data_sources[0].id;
  if (!dataSourceId) throw new Error('Notion client database is missing its data source');
  if (state.dataSourceId && state.dataSourceId !== dataSourceId) throw new Error('Saved Notion data source has changed; reconcile the destination before sending');
  save({ clientPageId, databaseId, pending: state.pending === 'database' ? null : state.pending });
  let source = await request(`data_sources/${encodeURIComponent(dataSourceId)}`);
  const missing = {};
  for (const [name, spec] of Object.entries(schema)) {
    const type = Object.keys(spec)[0];
    if (!source.properties?.[name]) missing[name] = spec;
    else if (source.properties[name].type !== type) throw new Error(`Notion project property ${name} must have type ${type}`);
  }
  if (Object.keys(missing).length) {
    if (missing.Name && Object.values(source.properties || {}).some(p => p.type === 'title')) throw new Error('Notion project database title property must be named Name');
    save({ pending: 'schema' });
    await request(`data_sources/${encodeURIComponent(dataSourceId)}`, 'PATCH', { properties: missing });
    structureCreated = true;
    source = await request(`data_sources/${encodeURIComponent(dataSourceId)}`);
    for (const [name, spec] of Object.entries(schema)) if (source.properties?.[name]?.type !== Object.keys(spec)[0]) throw new Error('Notion project schema update could not be verified');
  }
  if (state.pending === 'schema') save({ pending: null });
  const dateId = source.properties['Delivery date']?.id;
  if (!dateId) throw new Error('Notion delivery date property has no ID');
  const refs = await list(`views?database_id=${encodeURIComponent(databaseId)}`);
  const views = [];
  for (const ref of refs) views.push(await request(`views/${encodeURIComponent(ref.id)}`));
  const calendar = unique(views.filter(view => view.type === 'calendar' && view.data_source_id === dataSourceId && view.configuration?.date_property_id === dateId), 'delivery calendar views');
  let calendarViewId = calendar?.id;
  if (!calendarViewId) {
    uncertain('calendar');
    const view = await create('calendar', 'views', { database_id: databaseId, data_source_id: dataSourceId, name: 'Delivery calendar', type: 'calendar', configuration: { type: 'calendar', date_property_id: dateId, view_range: 'month' } });
    calendarViewId = view.id;
  }
  const destination = { dataSourceId, databaseId, clientPageId, calendarViewId };
  save({ ...destination, pending: null });
  return { ...destination, structureCreated };
  } catch (error) { error.structureCreated = structureCreated; error.uncertain = ['page', 'database', 'calendar', 'schema'].includes(state.pending); throw error; }
}

module.exports = { resolveClientDestination, routeKey };
