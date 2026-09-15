'use strict';
const { sha } = require('./core');
const { decideBrief } = require('./brief');
const { briefDocument, calendarEvent } = require('./google');

async function deliverGoogle(store, id, client, config) {
  const record = store.get(id);
  if (!record || record.review.kind !== 'client_briefs' || record.status !== 'approved' || !record.artifact || record.decision?.approval?.passed !== true) throw new Error('Approve client projects before sending to Google');
  const a = record.decision.approval;
  const expected = decideBrief(record.review, { decision: 'Approve projects', approvedProposalIds: a.approved_proposal_ids, confirmEvidence: true, notes: a.notes }, Date.parse(a.at));
  if (JSON.stringify(expected.artifact.projects) !== JSON.stringify(record.artifact.projects) || JSON.stringify(expected.artifact.approval) !== JSON.stringify(record.artifact.approval)) throw new Error('Approved artifact integrity check failed');
  const priorDestination = record.artifact.google_delivery;
  if (priorDestination && (priorDestination.root_folder_id !== config.rootFolderId || priorDestination.calendar_id !== config.calendarId)) throw new Error('Google destination changed. Restore the original connection to reconcile this delivery.');
  if (record.artifact.projects.some(p => !p.client?.trim())) throw new Error('Every approved project needs a client name before Google delivery');
  // Validate all content before making any external write.
  const content = record.artifact.projects.map(p => briefDocument(p, record.artifact));
  const delivery = { destination: 'google', status: 'delivered', root_folder_id: config.rootFolderId, calendar_id: config.calendarId, projects: [], error: null, writes_performed: false };
  // Persist the destination before the first external write, even if the process never returns a response.
  store.beginGoogleDelivery(id, { ...delivery, status: 'in_progress' });
  let activeKey;
  async function ensure(key, find, create, verify) {
    activeKey = key;
    const prior = store.googleOperation(key);
    if (prior?.state === 'delivered') return verify(prior.value);
    const found = await find();
    if (found) {
      store.claimGoogle(key, id);
      store.finishGoogle(key, found);
      delivery.writes_performed = true;
      return found;
    }
    if (prior || !store.claimGoogle(key, id)) {
      const e = new Error('Previous Google write is still uncertain. Check the destination before creating anything again.'); e.uncertain = true; throw e;
    }
    try {
      const result = await create();
      delivery.writes_performed = true;
      store.finishGoogle(key, result);
      return result;
    } catch (e) {
      if (e.uncertain === false) store.releaseGoogle(key);
      throw e;
    }
  }
  try {
    await client.validate();
    for (const [index, project] of record.artifact.projects.entries()) {
      const row = { project: project.name, folder_url: null, document_url: null, calendar_url: null, calendar_status: project.delivery_date ? 'pending' : 'skipped' };
      delivery.projects.push(row);
      const name = project.client.trim().normalize('NFC');
      const routeKey = sha(JSON.stringify(['google-folder-v1', config.rootFolderId, name]));
      const folder = await ensure(routeKey,
        () => client.findFolder(config.rootFolderId, routeKey, name),
        () => client.createFolder(config.rootFolderId, routeKey, name),
        r => client.verifyFolder(r.id, config.rootFolderId, routeKey, name));
      row.folder_url = folder.url;
      const documentKey = sha(JSON.stringify(['google-doc-v1', config.rootFolderId, folder.id, record.review.meeting_key, record.review.source_hash, project.id]));
      const doc = await ensure(documentKey,
        () => client.findDocument(folder.id, documentKey),
        () => client.createDocument(folder.id, documentKey, project.name),
        r => client.verifyDocument(r.id, folder.id, documentKey));
      row.document_url = doc.url;
      // Verified blank Docs are filled with a revision precondition; nonempty mismatches are never overwritten.
      activeKey = null;
      await client.fillDocument(doc.id, content[index]);
      delivery.writes_performed = true;
      if (!project.delivery_date) continue;
      const eventKey = sha(JSON.stringify(['google-event-v1', config.calendarId, documentKey]));
      const event = calendarEvent(project, doc.url, eventKey);
      const eventReceipt = await ensure(eventKey,
        () => client.findEvent(eventKey, event),
        () => client.createEvent(eventKey, event),
        async () => { const found = await client.findEvent(eventKey, event); if (!found) throw new Error('Previously delivered calendar event is missing. Reconcile manually.'); return found; });
      row.calendar_url = eventReceipt.url;
      row.calendar_status = 'delivered';
    }
  } catch (e) {
    delivery.status = e.uncertain || (activeKey && store.googleOperation(activeKey)?.state === 'uncertain') ? 'uncertain' : 'failed';
    delivery.error = e.message;
  }
  return store.saveGoogleDelivery(id, delivery);
}
module.exports = { deliverGoogle };
