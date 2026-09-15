const test = require('node:test');
const assert = require('node:assert/strict');
const { fathomConfig, saveFathomKey, createFathomClient, normalizeTranscript, FATHOM_CREDENTIAL_FILE } = require('../src/fathom');
const segment = { speaker: { display_name: 'Ana' }, timestamp: '00:01:02', text: 'Entrega em outubro.\nSem alterar o orçamento.' };
const ok = data => ({ ok: true, json: async () => data });

test('Fathom credentials use their separate protected file and explicit environment override', () => {
  assert.equal(fathomConfig({}, file => { assert.equal(file, FATHOM_CREDENTIAL_FILE); return { apiKey: 'saved' }; }).apiKey, 'saved');
  assert.equal(fathomConfig({ FATHOM_API_KEY: 'env' }, () => { throw Error('must not read'); }).apiKey, 'env');
  assert.equal(fathomConfig({ FATHOM_API_KEY: '' }, () => { throw Error('must not read'); }).configured, false);
  assert.equal(fathomConfig({}, () => { throw Error('secret'); }).error.includes('secret'), false);
  let written;
  saveFathomKey(' key ', (value, file) => { written = { value, file }; });
  assert.deepEqual(written, { value: { apiKey: 'key' }, file: FATHOM_CREDENTIAL_FILE });
  assert.throws(() => saveFathomKey('bad\nkey', () => assert.fail()), /Cannot save/);
});

test('Fathom reads metadata with safe encoded pagination and direct transcript with exact evidence', async () => {
  const calls = [];
  const client = createFathomClient({ apiKey: 'secret' }, async (url, options) => {
    calls.push({ url, options });
    return ok(calls.length === 1 ? { items: [{ recording_id: 123, title: 'Review', recording_start_time: '2026-09-14T10:00:00Z', default_summary: 'must not use' }], next_cursor: 'next' } : { transcript: [segment] });
  });
  const list = await client.listMeetings({ cursor: 'x&destination_url=https://bad.test', createdAfter: '2026-09-01T00:00:00Z' });
  assert.deepEqual(list, { items: [{ recording_id: '123', title: 'Review', started_at: '2026-09-14T10:00:00Z' }], next_cursor: 'next' });
  const result = await client.transcript('123', list.items[0]);
  assert.deepEqual(result, { title: 'Review', started_at: list.items[0].started_at, transcript: `[00:01:02] Ana: ${segment.text}` });
  assert.equal(new URL(calls[0].url).searchParams.get('destination_url'), null);
  assert.equal(calls[1].url, 'https://api.fathom.ai/external/v1/recordings/123/transcript');
  for (const { options } of calls) { assert.equal(options.redirect, 'error'); assert.equal(options.headers['X-Api-Key'], 'secret'); assert.ok(options.signal); assert.equal(options.method, 'GET'); }
});

test('Fathom rejects path injection before network and sanitizes transport and HTTP errors', async () => {
  const client = createFathomClient({ apiKey: 'secret' }, () => assert.fail('no request'));
  for (const id of ['../x', '1?destination_url=x', 'https://bad.test', 9007199254740992, '0']) await assert.rejects(client.transcript(id), /Invalid Fathom recording ID/);
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(createFathomClient({ apiKey: 'secret' }, async () => ({ ok: false, status, json: () => assert.fail('never inspect error body') })).listMeetings(), error => !error.message.includes('secret'));
  }
  await assert.rejects(createFathomClient({ apiKey: 'secret' }, async () => { throw Error('secret'); }).listMeetings(), /temporarily unreachable/);
});

test('Fathom fails visibly rather than truncating oversized or malformed transcripts', () => {
  assert.throws(() => normalizeTranscript([]), /not ready/);
  assert.throws(() => normalizeTranscript([{ ...segment, text: 'x'.repeat(40000) }]), /not shortened/);
  assert.throws(() => normalizeTranscript(Array.from({ length: 501 }, () => ({ ...segment, text: 'x' }))), /not shortened/);
  assert.throws(() => normalizeTranscript([{ ...segment, text: 'x\n'.repeat(501) }]), /not shortened/);
  assert.throws(() => normalizeTranscript([{ ...segment, text: undefined }]), /invalid transcript/);
  assert.throws(() => normalizeTranscript([segment], { title: 'x'.repeat(201) }), /200-character/);
  assert.throws(() => normalizeTranscript([{ ...segment, speaker: { display_name: 'A\nB' } }]), /invalid transcript/);
});

test('Fathom timestamps become ISO seconds and invalid metadata fails import', async () => {
  const started_at = '2026-09-14T10:00:00.123+02:00';
  const normalized = normalizeTranscript([segment], { title: 'Review', started_at });
  assert.equal(normalized.started_at, '2026-09-14T08:00:00Z');
  assert.equal(require('../src/brief').normalizeBrief(normalized).started_at, normalized.started_at);
  for (const date of [undefined, '', 'yesterday', '2026-02-30T10:00:00Z', '2026-09-14T10:00:00']) assert.throws(() => normalizeTranscript([segment], { started_at: date }), /meeting start/);
  const client = createFathomClient({ apiKey: 'key' }, async () => ok({ items: [{ recording_id: 12, title: 'Review', recording_start_time: started_at }] }));
  assert.equal((await client.listMeetings()).items[0].started_at, normalized.started_at);
});
