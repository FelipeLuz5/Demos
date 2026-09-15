'use strict';

const crypto = require('node:crypto');
const { baseConfig, fixtures } = require('./fixtures');
const { normalizeInput, buildReview, decide, approvedArtifact } = require('./core');
const { DEFAULT_OPENCLAW_MODEL } = require('./model');

function fixtureNames() {
  return Object.entries(fixtures).map(([id, fixture]) => ({ id, label: fixture.label, description: fixture.description }));
}

function buildFixtureReview(name, now = Date.now()) {
  const fixture = fixtures[name];
  if (!fixture) throw new Error('Unknown fixture');
  const source = normalizeInput(fixture.source, { ...baseConfig, model: 'offline-fixture' });
  return { source, extraction: fixture.extraction, review: buildReview(source, fixture.extraction, now) };
}

function manualConfig(input) {
  const owners = Array.isArray(input.owners) ? input.owners.map(value => String(value).trim()).filter(Boolean) : [];
  const aliases = Array.isArray(input.aliases) ? input.aliases.map(value => String(value).trim()).filter(Boolean) : [];
  const client = String(input.client || '').trim();
  const project = String(input.project || '').trim();
  if (!client || !project) throw new Error('Client and project are required');
  if (!owners.length) throw new Error('At least one approved owner is required');
  return {
    reviewer_name: String(input.reviewer || '').trim(),
    approval_hours: 24,
    model: DEFAULT_OPENCLAW_MODEL,
    owners,
    projects: [{ client, name: project, aliases: [...new Set([project, ...aliases])], approved_facts: String(input.approved_facts || '').trim() }]
  };
}

function newRunRecord(source, extraction, review) {
  return {
    id: crypto.randomUUID(), created_at: new Date().toISOString(), status: review.blockers.length ? 'blocked' : 'review',
    scenario: source.scenario, title: source.title, source_hash: source.source_hash, review_digest: review.digest, source, extraction, review
  };
}

function applyDecision(review, input, now = Date.now()) {
  if (input.decision === 'Review tasks') return require('./task-review').reviewTasks(review, input, now);
  if (!['Approve', 'Reject', 'Request clarification'].includes(input.decision)) throw new Error('Invalid decision');
  const decision = decide(review, input, now);
  let status;
  let artifact = null;
  if (input.decision === 'Reject') status = 'rejected';
  else if (input.decision === 'Request clarification') status = 'clarification';
  else if (decision.approval.passed) {
    status = 'approved';
    artifact = approvedArtifact(decision, now);
  } else status = 'blocked';
  return { status, decision, artifact };
}

function artifactMarkdown(record) {
  if (record.review.kind === 'client_briefs') {
    const proposals = record.artifact?.projects || record.review.proposals;
    const lines = [`# ${record.title}`, '', `Status: ${record.status}`, '', 'Project proposals are not external client commitments.', ''];
    for (const p of proposals) {
      lines.push(`## ${p.name}`, '', `Client: ${p.client || 'Unspecified'}`, `Delivery date: ${p.delivery_date || 'Unspecified'}`, '', p.description, '', 'Deliverables:', ...p.deliverables.map(d => `- ${d.text}`), '', 'Requirements:', ...p.requirements.map(r => `- ${r.text}`), '', 'Evidence:', ...p.evidence.map(e => `- Line ${e.line}: ${e.quote}`), '');
    }
    const google = record.artifact?.google_delivery;
    if (google) {
      lines.push('## Google delivery', '', `Status: ${google.status}`, '');
      for (const project of google.projects || []) {
        lines.push(`- ${project.project}`, `  - Drive folder: ${project.folder_url || 'Not created'}`, `  - Google Doc: ${project.document_url || 'Not created'}`, `  - Calendar: ${project.calendar_url || project.calendar_status}`, '');
      }
      if (google.error) lines.push(`Delivery issue: ${google.error}`, '');
    }
    if (record.artifact?.delivery?.destination === 'notion') lines.push(`Historical Notion delivery: ${record.artifact.delivery.status}`, '');
    lines.push(`External writes performed: ${record.artifact?.external_writes_performed === null ? 'uncertain' : Boolean(record.artifact?.external_writes_performed)}`);
    return lines.join('\n');
  }
  const artifact = record.artifact;
  const review = record.review;
  const decision = record.decision?.approval;
  const lines = [`# ${record.title}`, '', `Status: ${record.status}`, `Run: ${record.id}`, `Meeting: ${review.started_at}`, `Project: ${review.project ? `${review.project.client} / ${review.project.name}` : 'Unresolved'}`, ''];
  if (artifact) {
    lines.push('## Approved tasks', '');
    artifact.tasks.forEach((task, index) => {
      lines.push(`${index + 1}. **${task.title}** — ${task.owner}, due ${task.due}`);
      task.evidence.forEach(item => lines.push(`   - Line ${item.line}: “${item.quote}”`));
    });
  } else {
    lines.push('## Blockers', '', ...(review.blockers.length ? review.blockers.map(item => `- ${item}`) : ['- None']), '');
  }
  if (decision) lines.push('## Decision', '', `- Decision: ${decision.decision}`, `- Reviewer: ${decision.reviewer}`, `- At: ${decision.at}`, `- Passed: ${decision.passed}`, ...(decision.notes ? [`- Notes: ${decision.notes}`] : []), '');
  if (artifact?.email_draft) lines.push('## Clarification email draft (not sent)', '', artifact.email_draft.subject, '', artifact.email_draft.body, '');
  if (artifact?.delivery) lines.push('## Delivery', '', `Status: ${artifact.delivery.status}`, '');
  lines.push('## Source integrity', '', `- Source SHA-256: ${record.source_hash}`, `- Review SHA-256: ${record.review_digest}`, '- External writes performed: false');
  return lines.join('\n');
}

module.exports = { fixtureNames, buildFixtureReview, manualConfig, newRunRecord, applyDecision, artifactMarkdown };
