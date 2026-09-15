'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildFixtureReview, applyDecision } = require('../src/workflow');
const { assertApproved, buildReview, normalizeInput } = require('../src/core');
const { baseConfig, fixtures } = require('../src/fixtures');

test('PT05 produces one eligible task and an approved local artifact', () => {
  const now = Date.parse('2026-09-11T10:00:00Z');
  const { review } = buildFixtureReview('pt05', now);
  assert.deepEqual(review.blockers, []);
  assert.equal(review.candidates.length, 1);
  const result = applyDecision(review, { decision: 'Approve', confirmEvidence: true, notes: 'Checked.' }, now + 1000);
  assert.equal(result.status, 'approved');
  assert.equal(result.artifact.tasks.length, 1);
  assert.equal(result.artifact.local_only, true);
  assert.equal(result.artifact.external_writes_performed, false);
});

test('PT04 project conflict cannot pass approval', () => {
  const now = Date.parse('2026-09-11T10:00:00Z');
  const { review } = buildFixtureReview('pt04', now);
  assert.match(review.blockers.join('\n'), /conflict|project/i);
  const result = applyDecision(review, { decision: 'Approve', confirmEvidence: true }, now + 1000);
  assert.equal(result.status, 'blocked');
  assert.equal(result.decision.approval.passed, false);
  assert.equal(result.artifact, null);
});

test('full regression preserves exclusions and dependency order', () => {
  const { review } = buildFixtureReview('full');
  assert.equal(review.candidates.length, 2);
  assert.equal(review.unresolved.length, 2);
  assert.equal(review.suggestions.length, 1);
  assert.equal(review.candidates[0].title, 'Deliver the creative brief');
  assert.equal(review.candidates[1].dependencies[0].task_key, review.candidates[0].task_key);
});

test('tampering with a review invalidates the digest gate', () => {
  const now = Date.now();
  const { review } = buildFixtureReview('pt05', now);
  const approved = applyDecision(review, { decision: 'Approve', confirmEvidence: true }, now + 1000).decision;
  approved.candidates[0].title = 'Changed after approval';
  assert.throws(() => assertApproved(approved, now + 2000), /Approval gate failed/);
});

test('rejection and clarification never create an approved artifact', () => {
  for (const decision of ['Reject', 'Request clarification']) {
    const { review } = buildFixtureReview('pt05');
    const result = applyDecision(review, { decision, confirmEvidence: false });
    assert.equal(result.artifact, null);
    assert.equal(result.decision.approval.passed, false);
  }
});

test('a literal quote may omit the speaker prefix when its verified source line supports the owner', () => {
  const source = normalizeInput(fixtures.pt05.source, { ...baseConfig, model: 'offline-fixture' });
  const extraction = structuredClone(fixtures.pt05.extraction);
  extraction.tasks[0].evidence[0].quote = 'I will send the creative brief by September 12, 2026. Confirmo o prazo.';
  const review = buildReview(source, extraction);
  assert.equal(review.candidates.length, 1);
  assert.deepEqual(review.candidates[0].reasons, []);
});
