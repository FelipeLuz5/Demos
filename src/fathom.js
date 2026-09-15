'use strict';

const path = require('node:path');
const { PRIVATE_DIR, readCredentials, saveCredentials } = require('./google-auth');
const FATHOM_CREDENTIAL_FILE = path.join(PRIVATE_DIR, 'fathom-credentials.dpapi');

function validKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 4096 || /\s/.test(value.trim())) throw new Error('Enter a valid Fathom API key.');
  return value.trim();
}

function fathomConfig(env = process.env, read = readCredentials) {
  try {
    const key = env.FATHOM_API_KEY === undefined ? read(FATHOM_CREDENTIAL_FILE).apiKey : env.FATHOM_API_KEY;
    if (!key) return { apiKey: '', configured: false };
    return { apiKey: validKey(key), configured: true };
  } catch { return { apiKey: '', configured: false, error: 'Fathom credentials are unavailable. Connect Fathom again under the same Windows user.' }; }
}

function saveFathomKey(apiKey, save = saveCredentials) {
  try { save({ apiKey: validKey(apiKey) }, FATHOM_CREDENTIAL_FILE); }
  catch { throw new Error('Cannot save Fathom credentials. Use the same Windows user as the app and a valid API key.'); }
}

function recordingId(value) {
  const id = String(value);
  if (!/^[1-9]\d{0,19}$/.test(id) || (typeof value === 'number' && !Number.isSafeInteger(value))) throw new Error('Invalid Fathom recording ID.');
  return id;
}

function meetingStart(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Fathom meeting start is missing or invalid. Nothing was imported.');
  const day = value.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) throw new Error('Fathom meeting start is invalid. Nothing was imported.');
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeTranscript(segments, metadata = {}) {
  if (!Array.isArray(segments) || !segments.length) throw new Error('Fathom transcript is not ready or is empty. Try again after processing finishes.');
  const lines = segments.map(segment => {
    if (!segment || typeof segment.text !== 'string' || typeof segment.timestamp !== 'string' || !/^\d{2,}:\d{2}:\d{2}$/.test(segment.timestamp) || typeof segment.speaker?.display_name !== 'string' || !segment.speaker.display_name.trim() || /[\r\n]/.test(segment.speaker.display_name)) throw new Error('Fathom returned an invalid transcript segment. Nothing was imported.');
    return `[${segment.timestamp}] ${segment.speaker.display_name}: ${segment.text}`;
  });
  const transcript = lines.join('\n');
  if (!segments.some(segment => segment.text.trim())) throw new Error('Fathom transcript is empty. Nothing was imported.');
  if (transcript.length > 40000 || transcript.split(/\r\n|\r|\n/).length > 500) throw new Error('This Fathom transcript exceeds the review limit of 40,000 characters or 500 lines. Nothing was imported; the transcript was not shortened.');
  const title = metadata.title || 'Fathom meeting';
  if (typeof title !== 'string' || title.length > 200) throw new Error('Fathom meeting title exceeds the 200-character review limit. Nothing was imported.');
  return { title, started_at: meetingStart(metadata.started_at), transcript };
}

function createFathomClient(config, fetchImpl = fetch) {
  const apiKey = validKey(config?.apiKey);
  async function request(resource, query) {
    const url = new URL(`https://api.fathom.ai/external/v1/${resource}`);
    if (query) url.search = query.toString();
    let response;
    try { response = await fetchImpl(url.toString(), { method: 'GET', headers: { 'X-Api-Key': apiKey, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error('Fathom is temporarily unreachable. Try again later.'); }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new Error('Fathom access was denied. Check your API key and account API access.');
      if (response.status === 429) throw new Error('Fathom request limit reached. Try again later.');
      throw new Error(`Fathom request failed (HTTP ${Number(response.status) || 0}). Try again later.`);
    }
    try { return await response.json(); }
    catch { throw new Error('Fathom returned an invalid response.'); }
  }
  return {
    async listMeetings({ cursor, createdAfter } = {}) {
      const query = new URLSearchParams();
      if (cursor) {
        if (typeof cursor !== 'string' || cursor.length > 4096) throw new Error('Invalid Fathom page cursor.');
        query.set('cursor', cursor);
      }
      if (createdAfter) {
        if (typeof createdAfter !== 'string' || !Number.isFinite(Date.parse(createdAfter))) throw new Error('Invalid Fathom start date.');
        query.set('created_after', new Date(createdAfter).toISOString());
      }
      const data = await request('meetings', query);
      if (!data || !Array.isArray(data.items) || (data.next_cursor != null && (typeof data.next_cursor !== 'string' || data.next_cursor.length > 4096))) throw new Error('Fathom returned an invalid meeting list.');
      return { items: data.items.map(item => {
        if (!item || typeof (item.title || item.meeting_title) !== 'string') throw new Error('Fathom returned invalid meeting metadata.');
        return { recording_id: recordingId(item.recording_id), title: item.title || item.meeting_title, started_at: meetingStart(item.recording_start_time || item.scheduled_start_time || item.created_at) };
      }), next_cursor: data.next_cursor || null };
    },
    async transcript(id, metadata = {}) {
      const data = await request(`recordings/${recordingId(id)}/transcript`);
      return normalizeTranscript(data?.transcript, metadata);
    }
  };
}

module.exports = { fathomConfig, saveFathomKey, createFathomClient, normalizeTranscript, recordingId, FATHOM_CREDENTIAL_FILE };
