'use strict';

// Local sample formats only; importing never invokes a model or approves a plan.
function parseTranscriptFile(text, filename) {
  let transcript = String(text).replace(/^\uFEFF/, '').trim();
  if (!transcript) throw new Error('The transcript file is empty.');
  let title = '', started_at = '', owners = [];
  if (/\.json$/i.test(filename)) {
    const data = JSON.parse(transcript);
    const meeting = data.meeting || {};
    title = typeof meeting.title === 'string' ? meeting.title : '';
    started_at = typeof meeting.started_at === 'string' ? meeting.started_at : '';
    owners = Array.isArray(meeting.participants) ? meeting.participants.filter(x => typeof x === 'string') : [];
    const turns = data.payload?.transcript;
    if (!Array.isArray(turns) || !turns.length || turns.some(t => typeof t?.text !== 'string' || typeof t?.speaker?.name !== 'string')) {
      throw new Error('Unsupported JSON. Use the saved sample JSON or a plain-text transcript.');
    }
    transcript = [title, started_at ? `Meeting started at: ${started_at}` : '', owners.length ? `Participants: ${owners.join(', ')}` : '', ...turns.map(t => `${t.speaker.name}: ${t.text}`)].filter(Boolean).join('\n');
  } else if (/\.txt$/i.test(filename)) {
    const lines = transcript.split(/\r?\n/);
    title = lines[0].trim();
    started_at = (lines.find(l => /^Meeting started at:/i.test(l)) || '').replace(/^Meeting started at:\s*/i, '').trim();
    const participants = lines.find(l => /^Participants:/i.test(l));
    owners = participants ? participants.replace(/^Participants:\s*/i, '').split(',').map(x => x.trim()).filter(Boolean) : [];
  } else throw new Error('Choose a .txt or .json transcript sample.');
  if (transcript.length > 40000 || transcript.split(/\r?\n/).filter(l => l.trim()).length > 500) throw new Error('Transcript exceeds the limit of 40,000 characters or 500 lines.');
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(started_at) || !Number.isFinite(Date.parse(started_at))) started_at = '';
  const parts = title.replace(/^SYNTHETIC\s*[—–]\s*/i, '').split(/\s+[—–]\s+/);
  const client = parts.length >= 3 ? parts[0].trim() : '';
  const project = parts.length >= 3 ? parts[1].trim() : '';
  return { title, started_at, client, project, owners: [...new Set(owners)].join('\n'), transcript };
}

if (typeof module !== 'undefined') module.exports = { parseTranscriptFile };
