'use strict';

const { normalizeBrief, buildBriefReview } = require('./brief');

// Authored fictional examples. These are saved extraction shapes, not model outputs
// measured on customer meetings. Both modes use the same current brief validator.
const lines = [
  'Alex, Northstar Studio: We approve a new website with a home page and a contact page.',
  'Alex: The website must work on mobile and use our existing brand colours.',
  'Alex: We agree to website delivery on October 23, 2026.',
  'Sam: We could also make a winter catalogue, but we have not agreed to that project or its deadline.',
  'Alex: Do not include online payments in this website.'
];
const ref = n => [{ line: n, quote: lines[n - 1] }];
const website = {
  name: 'Northstar website', client: 'Northstar Studio',
  description: 'A mobile-friendly website with a home page and a contact page, using the existing brand colours. Online payments are outside scope.',
  deliverables: [{ text: 'Home page and contact page', evidence: ref(1) }],
  requirements: [{ text: 'Mobile-friendly layout and existing brand colours', evidence: ref(2) }, { text: 'Online payments are outside scope', evidence: ref(5) }],
  delivery_date: '2026-10-23', date_evidence: ref(3), status: 'confirmed', evidence: ref(1)
};
const catalogue = {
  name: 'Winter catalogue', client: 'Northstar Studio',
  description: 'A possible winter catalogue. The project and delivery date require a reviewer decision.',
  deliverables: [{ text: 'Winter catalogue', evidence: ref(4) }], requirements: [],
  delivery_date: null, date_evidence: [], status: 'needs_decision', evidence: ref(4)
};
const pt = 'Inês, Estúdio Horizonte: Aprovamos uma página de apresentação com os nossos serviços e contactos. Deve funcionar em telemóvel. Ainda não acordámos a data de entrega.';
const ptRef = [{ line: 1, quote: pt }];
const scenarios = {
  'website-and-catalogue': {
    label: '01 / Website + an undecided catalogue',
    description: 'Approve only the confirmed website. The catalogue needs judgment and has no agreed deadline. Inspect the source quotations before selecting projects.',
    title: 'Fictional / Northstar project review', transcript: lines.join('\n'),
    extraction: { proposals: [website, catalogue] }
  },
  'portuguese-undated': {
    label: '02 / Portuguese brief without a deadline',
    description: 'A confirmed Portuguese project with an unspecified delivery date. Approval preserves that missing date; connected delivery would create no calendar event.',
    title: 'Fictício / Estúdio Horizonte', transcript: pt,
    extraction: { proposals: [{ name: 'Página de apresentação', client: 'Estúdio Horizonte', description: 'Apresentar os serviços e contactos do estúdio numa página adaptada a telemóvel.', deliverables: [{ text: 'Página com serviços e contactos', evidence: ptRef }], requirements: [{ text: 'Adaptada a telemóvel', evidence: ptRef }], delivery_date: null, date_evidence: [], status: 'confirmed', evidence: ptRef }] }
  },
  'invalid-evidence': {
    label: '03 / Invalid evidence — expected rejection',
    description: 'The saved extraction cites a quotation absent from the transcript. Validation must reject it before saving a review. This scenario intentionally displays an error.',
    title: 'Fictional / Invalid extraction', transcript: lines.join('\n'),
    extraction: { proposals: [{ ...website, evidence: [{ line: 1, quote: 'We approve an e-commerce checkout.' }] }] }
  }
};

function fixtureNames() {
  return Object.entries(scenarios).map(([id, s]) => ({ id, label: s.label, description: s.description }));
}

function buildDemoReview(id, reviewer, now = Date.now()) {
  if (!Object.hasOwn(scenarios, id)) throw new Error('Unknown demo scenario');
  if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 100) throw new Error('Enter a reviewer name (up to 100 characters).');
  const fixture = scenarios[id];
  const source = normalizeBrief({ title: fixture.title, transcript: fixture.transcript, started_at: '2026-09-15T10:00:00Z', reviewer });
  const extraction = structuredClone(fixture.extraction);
  return { source, extraction, review: buildBriefReview(source, extraction, now) };
}

module.exports = { fixtureNames, buildDemoReview };
