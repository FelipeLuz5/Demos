'use strict';
const { runOpenClaw } = require('./model');
const { buildBriefPrompt } = require('./brief');

async function extractBrief(source, options = {}) {
  const raw = await (options.runner || runOpenClaw)({ prompt: buildBriefPrompt(source) + '\nFor every evidence object, copy an exact continuous substring from one supplied line and use that line\'s numeric line field. Never paraphrase quotes, add ellipses, combine separate sentences from different lines, or count lines yourself. Descriptions may summarize; evidence quotes must remain verbatim.' });
  const envelope = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (envelope?.status !== 'ok') throw new Error('Project brief extraction failed');
  const text = envelope?.result?.payloads?.find(p => typeof p.text === 'string')?.text;
  if (!text) throw new Error('No project brief output returned');
  try { return JSON.parse(text); }
  catch { throw new Error('Project brief output was not valid JSON'); }
}
module.exports = { extractBrief };
