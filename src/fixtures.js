'use strict';

const baseConfig = {
  reviewer_name: 'Felipe',
  approval_hours: 24,
  model: '',
  owners: ['Alice Hart', 'Ben Moss'],
  projects: [
    { client: 'Northstar Studio', name: 'Autumn Launch', aliases: ['Autumn Launch'], approved_facts: 'The approved launch project is Autumn Launch. No Winter Refresh work is in scope.' },
    { client: 'Northstar Studio', name: 'Winter Refresh', aliases: ['Winter Refresh'], approved_facts: 'Separate project. Do not mix its tasks with Autumn Launch.' }
  ]
};

const pt05Transcript = [
  'Moderador: Esta reunião é da Northstar Studio, projeto Autumn Launch. Vamos combinar os próximos passos.',
  'Alice Hart: I will send the creative brief by September 12, 2026. Confirmo o prazo.'
].join('\n');

const pt05 = {
  label: 'PT05 — mixed language, ready',
  description: 'One supported commitment. Approval should produce one local task.',
  source: { scenario: 'PT05-misto', title: 'SINTÉTICO Northstar PT05-misto', started_at: '2026-09-07T09:00:00+01:00', transcript: pt05Transcript },
  extraction: {
    project: { client: 'Northstar Studio', name: 'Autumn Launch', evidence: [{ line: 1, quote: pt05Transcript.split('\n')[0] }] },
    decisions: [],
    tasks: [{ title: 'Enviar o briefing criativo', owner: 'Alice Hart', due: '2026-09-12', commitment: 'confirmed', deadline_status: 'confirmed', evidence: [{ line: 2, quote: pt05Transcript.split('\n')[1] }], confidence: 0.99, dependencies: [] }],
    suggestions: [], ambiguities: [], conflicts: []
  }
};

const pt04Transcript = [
  'Moderador: Esta reunião é da Northstar Studio, projeto Autumn Launch. Vamos combinar os próximos passos.',
  'Alice Hart: Eu trato do briefing criativo. Envio-o até 12 de setembro de 2026; confirmo esse prazo.',
  'Cliente: Afinal isto pertence ao Winter Refresh, não ao Autumn Launch. Ainda não resolvemos qual é o projeto.'
].join('\n');

const pt04 = {
  label: 'PT04 — project conflict, blocked',
  description: 'Two projects are named. Approval must remain blocked.',
  source: { scenario: 'PT04-conflito', title: 'SINTÉTICO Northstar PT04-conflito', started_at: '2026-09-07T09:00:00+01:00', transcript: pt04Transcript },
  extraction: {
    project: { client: 'Northstar Studio', name: null, evidence: [{ line: 1, quote: pt04Transcript.split('\n')[0] }, { line: 3, quote: pt04Transcript.split('\n')[2] }] },
    decisions: [],
    tasks: [{ title: 'Enviar o briefing criativo', owner: 'Alice Hart', due: '2026-09-12', commitment: 'confirmed', deadline_status: 'confirmed', evidence: [{ line: 2, quote: pt04Transcript.split('\n')[1] }], confidence: 0.97, dependencies: [] }],
    suggestions: [], ambiguities: [],
    conflicts: [{ text: 'Há um conflito sobre a atribuição do projeto: Autumn Launch ou Winter Refresh.', evidence: [{ line: 1, quote: pt04Transcript.split('\n')[0] }, { line: 3, quote: pt04Transcript.split('\n')[2] }] }]
  }
};

const fullTranscript = [
  'Chair: This is Northstar Studio, Autumn Launch.',
  'Alice Hart: I will deliver the creative brief by 2026-09-12. I confirm that deadline.',
  'Ben Moss: I will deliver the channel budget by 2026-09-15. I confirm that deadline. This depends on Alice Hart delivering the creative brief.',
  'Client: It would be great to get the landing page by 2026-09-14, but the date is unconfirmed.',
  'Chair: We need someone to audit the asset library; no owner has agreed.',
  'Alice Hart: Maybe we could try podcast sponsorship next quarter.',
  'Chair: Confirmed with the client: all commitments in this meeting are for Northstar Studio, Autumn Launch.'
];

const full = {
  label: 'Full regression — dependencies and exclusions',
  description: 'Two eligible tasks, two excluded actions, one suggestion, and a dependency.',
  source: { scenario: 'Full regression', title: 'Fictional Northstar planning meeting', started_at: '2026-09-07T10:00:00+02:00', transcript: fullTranscript.join('\n') },
  extraction: {
    project: { client: 'Northstar Studio', name: 'Autumn Launch', evidence: [{ line: 1, quote: fullTranscript[0] }] },
    decisions: [{ text: 'The client confirms Autumn Launch as the project', evidence: [{ line: 7, quote: fullTranscript[6] }] }],
    tasks: [
      { title: 'Deliver the creative brief', owner: 'Alice Hart', due: '2026-09-12', commitment: 'confirmed', deadline_status: 'confirmed', evidence: [{ line: 2, quote: fullTranscript[1] }], confidence: 0.98, dependencies: [] },
      { title: 'Deliver the channel budget', owner: 'Ben Moss', due: '2026-09-15', commitment: 'confirmed', deadline_status: 'confirmed', evidence: [{ line: 3, quote: fullTranscript[2] }], confidence: 0.98, dependencies: [{ target: 0, description: 'Alice Hart delivers the creative brief', evidence: [{ line: 3, quote: fullTranscript[2] }] }] },
      { title: 'Prepare the landing page', owner: null, due: '2026-09-14', commitment: 'requested', deadline_status: 'requested', evidence: [{ line: 4, quote: fullTranscript[3] }], confidence: 0.98, dependencies: [] },
      { title: 'Audit the asset library', owner: null, due: null, commitment: 'requested', deadline_status: 'missing', evidence: [{ line: 5, quote: fullTranscript[4] }], confidence: 0.98, dependencies: [] }
    ],
    suggestions: [{ text: 'Try podcast sponsorship next quarter', evidence: [{ line: 6, quote: fullTranscript[5] }] }], ambiguities: [], conflicts: []
  }
};

const fixtures = { pt05, pt04, full };

module.exports = { baseConfig, fixtures };
