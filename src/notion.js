'use strict';

const NOTION_VERSION = '2025-09-03';

function notionConfig(env = process.env) {
  const config = {
    token: (env.NOTION_TOKEN || '').trim(),
    dataSourceId: (env.NOTION_DATA_SOURCE_ID || '').trim(),
    parentPageId: (env.NOTION_PARENT_PAGE_ID || '').trim(),
    titleProperty: (env.NOTION_TITLE_PROPERTY || 'Name').trim(),
    dateProperty: (env.NOTION_DATE_PROPERTY || 'Delivery date').trim(),
    keyProperty: (env.NOTION_KEY_PROPERTY || 'FDE key').trim()
  };
  config.configured = Boolean(config.token && (config.parentPageId || config.dataSourceId));
  return config;
}

function richText(value) {
  const chars = Array.from(String(value ?? ''));
  const result = [];
  // UTF-16 length also stays below Notion's 2,000-character limit.
  let chunk = '';
  for (const char of chars) {
    if ((chunk + char).length > 2000) { result.push({ type: 'text', text: { content: chunk } }); chunk = ''; }
    chunk += char;
  }
  if (chunk) result.push({ type: 'text', text: { content: chunk } });
  if (result.length > 100) throw new Error('Notion text exceeds the supported size');
  return result;
}

function pagePayload(config, project, artifact, key) {
  if (!artifact?.approval?.passed || !artifact.approval.approved_proposal_ids?.includes(project.id)) throw new Error('Project requires recorded human approval');
  if (!key || key.length > 2000) throw new Error('Invalid Notion delivery key');
  const children = [];
  function block(type, text) { children.push({ object: 'block', type, [type]: { rich_text: richText(text) } }); }
  block('paragraph', `Client: ${project.client || 'Unspecified'}`);
  block('paragraph', project.description);
  for (const [label, items] of [['Deliverables', project.deliverables], ['Requirements', project.requirements]]) {
    if (!items?.length) continue;
    block('heading_2', label);
    for (const item of items) block('bulleted_list_item', item.text);
  }
  if (children.length > 100) throw new Error('Project exceeds Notion limit of 100 content blocks; shorten the brief before delivery');
  const payload = {
    parent: { type: 'data_source_id', data_source_id: config.dataSourceId },
    properties: {
      [config.titleProperty]: { title: richText(project.name) },
      [config.dateProperty]: { date: project.delivery_date ? { start: project.delivery_date } : null },
      [config.keyProperty]: { rich_text: richText(key) }
    }, children
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > 490000) throw new Error('Project exceeds supported Notion request size');
  return payload;
}

function createNotionClient(config, fetchImpl = fetch) {
  async function request(path, method = 'GET', body, mutation = false) {
    if (!config.configured) throw new Error('Configure NOTION_TOKEN and NOTION_DATA_SOURCE_ID first');
    let response;
    try {
      response = await fetchImpl(`https://api.notion.com/v1/${path}`, {
        method, headers: { Authorization: `Bearer ${config.token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000), redirect: 'error'
      });
    } catch {
      const error = new Error(mutation ? 'Notion delivery outcome is uncertain; reconcile before retrying' : 'Notion request failed or timed out');
      error.uncertain = mutation;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`Notion request failed (HTTP ${response.status})`);
      error.uncertain = mutation && (response.status >= 500 || response.status === 408);
      throw error;
    }
    try { return await response.json(); } catch {
      const error = new Error('Notion returned an unreadable response'); error.uncertain = mutation; throw error;
    }
  }
  function page(result, mutation = false) {
    if (!result?.id || !result?.url) { const error = new Error('Notion returned an incomplete page receipt'); error.uncertain = mutation; throw error; }
    return { id: result.id, url: result.url };
  }
  return {
    async validate() {
      if (new Set([config.titleProperty, config.dateProperty, config.keyProperty]).size !== 3) throw new Error('Notion property mappings must be distinct');
      const source = await request(`data_sources/${encodeURIComponent(config.dataSourceId)}`);
      for (const [name, type] of [[config.titleProperty, 'title'], [config.dateProperty, 'date'], [config.keyProperty, 'rich_text']]) {
        if (source.properties?.[name]?.type !== type) throw new Error(`Notion requires property "${name}" with type ${type}`);
      }
      return { id: source.id || config.dataSourceId, valid: true };
    },
    async find(key) {
      const result = await request(`data_sources/${encodeURIComponent(config.dataSourceId)}/query`, 'POST', { filter: { property: config.keyProperty, rich_text: { equals: key } }, page_size: 2 });
      if (!Array.isArray(result.results)) throw new Error('Notion returned an invalid query response');
      if (result.results.length > 1 || result.has_more) throw new Error('Multiple Notion pages have the delivery key; manual reconciliation required');
      return result.results.length ? page(result.results[0]) : null;
    },
    async create(project, artifact, key) {
      const payload = pagePayload(config, project, artifact, key);
      return page(await request('pages', 'POST', payload, true), true);
    }
  };
}

module.exports = { NOTION_VERSION, notionConfig, createNotionClient, pagePayload };
