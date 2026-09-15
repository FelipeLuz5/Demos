'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBrief, buildBriefReview, decideBrief, buildBriefPrompt } = require('../src/brief');
const now = Date.parse('2026-09-11T10:00:00Z');
const source = () => normalizeBrief({ title: 'Client launch', started_at: '2026-09-11T10:00:00Z', reviewer: 'Felipe', transcript: 'Client: We approve the landing page, mobile-friendly, for September 25, 2026.' });
const evidence = [{ line: 1, quote: 'We approve the landing page, mobile-friendly, for September 25, 2026.' }];
const extraction = () => ({ proposals: [{ name: 'Landing page', client: null, description: 'Client landing page', deliverables: [{ text: 'Landing page', evidence }], requirements: [{ text: 'Mobile-friendly', evidence }], delivery_date: '2026-09-25', date_evidence: evidence, status: 'confirmed', evidence }] });

test('client brief extracts and approves project without owners or a project registry', () => {
  const review = buildBriefReview(source(), extraction(), now);
  const result = decideBrief(review, { decision: 'Approve projects', approvedProposalIds: [review.proposals[0].id], confirmEvidence: true }, now + 1);
  assert.equal(result.status, 'approved');
  assert.equal(result.artifact.projects[0].delivery_date, '2026-09-25');
  assert.equal(result.artifact.external_writes_performed, false);
  assert.equal(result.artifact.tasks, undefined);
  assert.equal(result.artifact.email_draft, undefined);
});

test('uncertain project can be explicitly approved with unspecified deadline', () => {
  const data = extraction(); Object.assign(data.proposals[0], { status: 'needs_decision', delivery_date: null, date_evidence: [] });
  const review = buildBriefReview(source(), data, now);
  assert.equal(decideBrief(review, { decision: 'Approve projects', approvedProposalIds: [review.proposals[0].id], confirmEvidence: true }, now).artifact.projects[0].delivery_date, null);
  assert.equal(decideBrief(review, { decision: 'Reject' }, now).artifact, null);
});

test('invalid evidence, unsupported dates and unexpected task fields fail closed', () => {
  for (const mutate of [
    p => { p.evidence = [{ line: 1, quote: 'Not in transcript' }]; },
    p => { p.delivery_date = '2026-09-24'; },
    p => { p.owner = 'Invented'; },
    p => { p.deliverables[0].evidence = []; }
  ]) {
    const data = structuredClone(extraction()); mutate(data.proposals[0]);
    assert.throws(() => buildBriefReview(source(), data, now));
  }
});

test('approval enforces snapshot integrity, expiry, reviewer and explicit selection', () => {
  const review = buildBriefReview(source(), extraction(), now);
  const input = { decision: 'Approve projects', approvedProposalIds: [review.proposals[0].id], confirmEvidence: true };
  assert.throws(() => decideBrief(review, input, now + 86400000), /expired/);
  assert.throws(() => decideBrief(review, { ...input, approvedProposalIds: ['unknown'] }, now), /selection/);
  assert.throws(() => decideBrief(review, { ...input, approvedProposalIds: [input.approvedProposalIds[0], input.approvedProposalIds[0]] }, now), /selection/);
  assert.throws(() => decideBrief(review, { ...input, confirmEvidence: false }, now), /confirm/);
  const changed = structuredClone(review); changed.proposals[0].name = 'Forged';
  assert.throws(() => decideBrief(changed, input, now), /snapshot/);
  const changedSource = source(); changedSource.lines[0].text = 'Forged';
  assert.throws(() => buildBriefReview(changedSource, extraction(), now), /integrity/);
  const anonymous = source(); anonymous.config.reviewer_name = '';
  const anonymousReview = buildBriefReview(anonymous, extraction(), now);
  assert.throws(() => decideBrief(anonymousReview, { ...input, approvedProposalIds: [anonymousReview.proposals[0].id] }, now), /reviewer/);
});

test('empty meeting result is valid but cannot create an empty approved project export', () => {
  const review = buildBriefReview(source(), { proposals: [] }, now);
  assert.throws(() => decideBrief(review, { decision: 'Approve projects', approvedProposalIds: [], confirmEvidence: true }, now));
  assert.equal(decideBrief(review, { decision: 'Reject' }, now).status, 'rejected');
  assert.match(buildBriefPrompt(source()), /Do not borrow individual internal task dates/);
  assert.throws(() => normalizeBrief({ title: 'x', started_at: '2026-02-31T10:00:00Z', transcript: 'x' }), /timestamp/);
});

test('date outside the literal cited quote cannot support project delivery date', () => {
  const s = normalizeBrief({ title: 'Website', started_at: '2026-09-11T10:00:00Z', reviewer: 'Felipe', transcript: 'Website approved; date unknown. Internal task due September 25, 2026.' });
  const data = extraction();
  const quote = [{ line: 1, quote: 'Website approved; date unknown.' }];
  data.proposals[0].evidence = quote;
  data.proposals[0].deliverables[0].evidence = quote;
  data.proposals[0].requirements = [];
  data.proposals[0].date_evidence = quote;
  assert.throws(() => buildBriefReview(s, data, now), /not supported/);
});

test('unique exact quotations repair wrong line numbers without mutating model output', () => {
  const data = structuredClone(extraction());
  data.proposals[0].deliverables[0].evidence[0].line = 99;
  const review = buildBriefReview(source(), data, now);
  assert.equal(review.proposals[0].deliverables[0].evidence[0].line, 1);
  assert.equal(data.proposals[0].deliverables[0].evidence[0].line, 99);
  assert.equal(review.proposals[0].deliverables[0].evidence[0].quote, evidence[0].quote);
});

test('paraphrased and ambiguous wrongly numbered quotes are rejected', () => {
  const data = structuredClone(extraction());
  data.proposals[0].deliverables[0].evidence = [{line:99,quote:'We approve a website'}];
  assert.throws(()=>buildBriefReview(source(),data,now), /exact transcript quotation/);
  const s = normalizeBrief({title:'Meeting',started_at:'2026-09-11T10:00:00Z',reviewer:'Felipe',transcript:source().transcript+'\n'+source().transcript});
  data.proposals[0].deliverables[0].evidence = [{line:99,quote:evidence[0].quote}];
  assert.throws(()=>buildBriefReview(s,data,now), /multiple transcript lines/);
});
