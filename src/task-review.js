'use strict';
const { sha, clone, reviewDigest } = require('./core');

function reviewTasks(review, input, now = Date.now()) {
  if (review.digest !== reviewDigest(review) || sha(review.transcript) !== review.source_hash) throw new Error('Review snapshot changed');
  if (!Number.isFinite(Date.parse(review.expires_at)) || now >= Date.parse(review.expires_at)) throw new Error('Approval expired; create a new review');
  if (input.confirmEvidence !== true || !review.config.reviewer_name?.trim() || review.config.reviewer_name === 'CONFIGURE_REVIEWER') throw new Error('Named reviewer and evidence confirmation required');
  if (!Array.isArray(input.approvedTaskKeys) || !Array.isArray(input.clarifications)) throw new Error('Task selections and clarification list required');
  const keys = new Set(input.approvedTaskKeys);
  if (keys.size !== input.approvedTaskKeys.length || [...keys].some(k => !review.candidates.some(t => t.task_key === k))) throw new Error('Invalid approved task selection');
  const tasks = review.candidates.filter(t => keys.has(t.task_key));
  // Ordinary ambiguity can remain pending; identity, evidence and dependency failures cannot.
  const blockers = review.blockers.filter(b => !b.startsWith('Ambiguity: ') && b !== 'No eligible tasks');
  if (tasks.length && blockers.length) throw new Error(`Resolve blocking evidence/project issues first: ${blockers.join('; ')}`);
  for (const task of tasks) {
    if (task.dependencies.some(d => !keys.has(d.task_key))) throw new Error(`Approve the prerequisite too, or leave dependent task pending: ${task.title}`);
  }
  const seen = new Set();
  const questions = input.clarifications.map(q => {
    if (!Number.isInteger(q?.index) || q.index < 0 || q.index >= review.unresolved.length || seen.has(q.index) || typeof q.comment !== 'string' || !q.comment.trim() || q.comment.length > 2000) throw new Error('Invalid clarification comment');
    seen.add(q.index);
    const item = review.unresolved[q.index];
    return { id: sha(`${review.review_id}:unresolved:${q.index}`), index: q.index, item: item.text, comment: q.comment.trim(), evidence: clone(item.evidence), reasons: clone(item.reasons), status: 'awaiting_clarification' };
  });
  if (!tasks.length && !questions.length) throw new Error('Select at least one task or write a clarification request');
  const approval = { passed: tasks.length > 0, decision: 'Review tasks', reviewer: review.config.reviewer_name, at: new Date(now).toISOString(), notes: typeof input.notes === 'string' ? input.notes.slice(0, 2000) : '', review_id: review.review_id, digest: review.digest, approved_task_keys: [...keys], errors: [] };
  const email_draft = questions.length ? {
    status: 'draft', method: 'template', recipient: '',
    subject: `Clarificações — ${review.title}`,
    body: `Olá,\n\nPara concluirmos o plano da reunião «${review.title}», precisamos de esclarecer os seguintes pontos:\n\n${questions.map((q, i) => `${i + 1}. ${q.item}\n${q.comment}`).join('\n\n')}\n\nPodem confirmar estes pontos? Os itens acima continuam pendentes de esclarecimento.\n\nObrigado,\n${review.config.reviewer_name}`
  } : null;
  const artifact = { schema_version: 'fde.task-review.v2', kind: 'reviewed_meeting_project_plan', local_only: true, external_writes_performed: false,
    meeting: { title: review.title, started_at: review.started_at, meeting_key: review.meeting_key, source_hash: review.source_hash },
    project: clone(review.project), approval, tasks: clone(tasks), pending_tasks: clone(review.candidates.filter(t => !keys.has(t.task_key))), unresolved: clone(review.unresolved), suggestions: clone(review.suggestions), clarifications: questions, email_draft,
    delivery: { status: tasks.length ? 'not_configured' : 'not_requested', destination: null, idempotency_key: sha(`${review.review_id}:${[...keys].sort().join(',')}`) }
  };
  return { status: tasks.length ? 'approved' : 'clarification', decision: { ...clone(review), approval }, artifact };
}
module.exports = { reviewTasks };
