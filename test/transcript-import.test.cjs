const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseTranscriptFile } = require('../public/transcript-import');

test('plain fictional transcript remains intact on local import', () => {
  const transcript = 'Alex: We approve the website.\nSam: Delivery is 2026-10-23.';
  assert.equal(parseTranscriptFile(transcript, 'meeting.txt').transcript, transcript);
});

test('missing metadata stays empty and unsupported inputs fail', () => {
  const result = parseTranscriptFile('Weekly sync\nAna: Olá.', 'sample.txt');
  for (const key of ['client', 'project', 'started_at', 'owners']) assert.equal(result[key], '');
  assert.throws(() => parseTranscriptFile('{}', 'sample.json'), /Unsupported JSON/);
  assert.throws(() => parseTranscriptFile('x', 'sample.pdf'), /Choose/);
  assert.throws(() => parseTranscriptFile('x'.repeat(40001), 'sample.txt'), /limit/);
});
