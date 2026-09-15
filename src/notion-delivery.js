'use strict';
const { sha } = require('./core');
const { decideBrief } = require('./brief');

async function deliverNotion(store, id, client, config) {
  const record = store.get(id);
  if (!record || record.review.kind !== 'client_briefs' || record.status !== 'approved' || !record.artifact || record.decision?.approval?.passed !== true) throw new Error('Approve client projects before sending to Notion');
  const a = record.decision.approval;
  const expected = decideBrief(record.review, { decision: 'Approve projects', approvedProposalIds: a.approved_proposal_ids, confirmEvidence: true, notes: a.notes }, Date.parse(a.at));
  if (JSON.stringify(expected.artifact.projects) !== JSON.stringify(record.artifact.projects) || JSON.stringify(expected.artifact.approval) !== JSON.stringify(record.artifact.approval)) throw new Error('Approved artifact integrity check failed');
  if (!config.parentPageId) await client.validate();
  if (config.parentPageId && record.artifact.projects.some(p => !p.client?.trim())) throw new Error('Each approved project needs a client name before automatic Notion routing');
  const pages = [];
  let status = 'delivered';
  let error = null;
  let structureCreated = false;
  for (const project of record.artifact.projects) {
    let key;
    try {
      let targetConfig = config;
      let targetClient = client;
      if (config.parentPageId) {
        const route = await require('./notion-routing').resolveClientDestination(store, config, project.client);
        structureCreated ||= Boolean(route.structureCreated);
        targetConfig = { ...config, ...route };
        targetClient = require('./notion').createNotionClient(targetConfig);
        await targetClient.validate();
      }
      key = sha(JSON.stringify([targetConfig.dataSourceId, record.review.meeting_key, record.review.source_hash, project.id]));
      const prior = store.notionDelivery(key);
      if (prior?.state === 'delivered') { pages.push({ project: project.name, id: prior.page_id, url: prior.page_url }); continue; }
      const found = await targetClient.find(key);
      if (found) {
        store.claimNotion(key, id);
        store.finishNotion(key, found);
        pages.push({ project: project.name, ...found });
        continue;
      }
      require('./notion').pagePayload(targetConfig, project, record.artifact, key);
      if (prior || !store.claimNotion(key, id)) throw new Error('Previous send outcome is uncertain. Check Notion before attempting another creation.');
      let page;
      try { page = await targetClient.create(project, record.artifact, key); }
      catch (error) { if (error.uncertain === false) store.releaseNotion(key); throw error; }
      store.finishNotion(key, page);
      pages.push({ project: project.name, ...page });
    } catch (e) {
      structureCreated ||= Boolean(e.structureCreated);
      status = (key && store.notionDelivery(key)?.state === 'uncertain') || e.uncertain ? 'uncertain' : 'failed';
      error = e.message;
      break;
    }
  }
  return store.saveDelivery(id, { status, destination: 'notion', data_source_id: config.dataSourceId || null, parent_page_id: config.parentPageId || null, structure_created: structureCreated, pages, error });
}
module.exports = { deliverNotion };
