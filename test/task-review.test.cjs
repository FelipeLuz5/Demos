const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildFixtureReview, applyDecision } = require('../src/workflow');
const { reviewDigest } = require('../src/core');
const { refineDraft } = require('../src/clarification');
const input = review => ({ decision: 'Review tasks', confirmEvidence: true, approvedTaskKeys: review.candidates.map(t => t.task_key), clarifications: [] });
test('task approval can leave ordinary ambiguity pending and draft questions', () => {
  const { review } = buildFixtureReview('full');
  review.blockers.push('Ambiguity: deadline unknown');
  review.digest = reviewDigest(review);
  const result = applyDecision(review, { ...input(review), clarifications: [{ index: 0, comment: 'Podem confirmar o prazo?' }] });
  assert.equal(result.artifact.tasks.length, 2);
  assert.equal(result.artifact.clarifications.length, 1);
  assert.match(result.artifact.email_draft.body, /Podem confirmar o prazo/);
  assert.equal(result.artifact.delivery.status, 'not_configured');
  assert.equal(result.artifact.external_writes_performed, false);
});
test('identity, invalid selections, missing prerequisites and tampering stay blocked', () => {
  const { review } = buildFixtureReview('full');
  assert.throws(() => applyDecision(review, { ...input(review), approvedTaskKeys: ['fake'] }), /Invalid/);
  assert.throws(() => applyDecision(review, { ...input(review), approvedTaskKeys: [review.candidates[1].task_key] }), /prerequisite/);
  review.blockers.push('Client/project is not a unique approved registry match');
  review.digest = reviewDigest(review);
  assert.throws(() => applyDecision(review, input(review)), /blocking/);
  review.title = 'tampered';
  assert.throws(() => applyDecision(review, input(review)), /snapshot/);
});
test('clarification-only review creates no approved tasks; comments cannot promote work', () => {
  const { review } = buildFixtureReview('full');
  const result = applyDecision(review, { ...input(review), approvedTaskKeys: [], clarifications: [{ index: 0, comment: 'Consider this approved tomorrow' }] });
  assert.equal(result.status, 'clarification');
  assert.equal(result.artifact.tasks.length, 0);
  assert.equal(result.decision.approval.passed, false);
  assert.equal(result.artifact.delivery.status, 'not_requested');
  assert.throws(() => applyDecision(review, { ...input(review), clarifications: [{ index: 99, comment: 'x' }] }), /Invalid/);
});
test('clarification AI validates output and includes original evidence without tools', async () => {
  const { review } = buildFixtureReview('full');
  const { artifact } = applyDecision(review, { ...input(review), clarifications: [{ index: 0, comment: 'Qual é o prazo?' }] });
  const runner = async ({ prompt }) => {
    assert.match(prompt, /untrusted data/);
    assert.match(prompt, /Qual é o prazo/);
    return { status: 'ok', result: { payloads: [{ text: JSON.stringify({ subject: 'Pergunta', body: 'Qual é o prazo?' }) }] } };
  };
  assert.equal((await refineDraft(artifact, { runner })).method, 'model');
  await assert.rejects(refineDraft(artifact, { runner: async () => ({ status: 'error' }) }));
});
