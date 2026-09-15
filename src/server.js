'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RunStore } = require('./db');
const { normalizeInput, buildReview } = require('./core');
const { DEFAULT_OPENCLAW_MODEL, DEFAULT_OPENCLAW_THINKING, OPENCLAW_PROVIDER, extractWithOpenClaw } = require('./model');
const { fixtureNames, buildFixtureReview, manualConfig, newRunRecord, applyDecision, artifactMarkdown } = require('./workflow');

const publicDir = path.join(__dirname, '..', 'public');
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/google-setup.html': ['google-setup.html', 'text/html; charset=utf-8'],
  '/google-setup.css': ['google-setup.css', 'text/css; charset=utf-8'],
  '/consent.js': ['consent.js', 'text/javascript; charset=utf-8'],
  '/transcript-import.js': ['transcript-import.js', 'text/javascript; charset=utf-8'],
  '/fathom.js': ['fathom.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8']
};

function createApp(options = {}) {
  const portfolio = options.portfolio !== false;
  const database = options.database || path.join(__dirname, '..', 'data', portfolio ? 'portfolio.sqlite' : 'workflow.sqlite');
  const store = options.store || new RunStore(database);
  const extractor = options.extractor || extractWithOpenClaw;
  const briefExtractor = options.briefExtractor || require('./brief-model').extractBrief;
  const draftRefiner = options.draftRefiner || require('./clarification').refineDraft;
  const drafting = new Set();
  let googleSending = false;
  const googleConfig = portfolio ? { configured: false, credentialsConfigured: false } : options.googleConfig || require('./google-auth').googleConfig();
  const googleClient = portfolio ? null : options.googleClient || (googleConfig.configured ? require('./google').createGoogleClient(googleConfig) : null);
  const fathom = portfolio ? { fathomConfig: () => ({ configured: false }) } : options.fathom || require('./fathom');
  let fathomClient;
  let fathomBusy = false;
  const fathomMeetings = new Map();
  const getFathomClient = () => {
    if (!fathomClient) {
      const config = fathom.fathomConfig();
      if (!config.configured) throw new HttpError(400, config.error || 'Connect Fathom first.');
      fathomClient = fathom.createFathomClient(config);
    }
    return fathomClient;
  };
  const csrf = crypto.randomBytes(24).toString('base64url');

  const server = http.createServer(async (request, response) => {
    setHeaders(response);
    try {
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host || '')) throw new HttpError(403, 'Use the local application address');
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/google/status') {
        return json(response, 200, { configured: googleConfig.configured, credentialsConfigured: googleConfig.credentialsConfigured, rootFolderId: googleConfig.rootFolderId || null, calendarId: googleConfig.calendarId || null, ...(googleConfig.error ? { error: googleConfig.error } : {}) });
      }
      if (request.method === 'GET' && url.pathname === '/api/fathom/status') {
        const config = fathom.fathomConfig();
        return json(response, 200, { configured: config.configured, ...(config.error ? { error: config.error } : {}) });
      }
      if (request.method === 'GET' && url.pathname === '/api/notion/status') {
        return json(response, 200, { configured: false, retired: true });
      }
      if (portfolio && url.pathname === '/google-setup.html') throw new HttpError(403, 'Account setup is disabled in the offline portfolio.');
      if (request.method === 'GET' && staticFiles[url.pathname]) return sendFile(response, ...staticFiles[url.pathname]);
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') return json(response, 200, { csrf, portfolio, demoFixtures: portfolio ? require('./demo-fixtures').fixtureNames() : [], fixtures: fixtureNames(), model: { configured: !portfolio, provider: OPENCLAW_PROVIDER, name: DEFAULT_OPENCLAW_MODEL, thinking: process.env.FDE_OPENCLAW_THINKING || DEFAULT_OPENCLAW_THINKING }, limits: { transcriptCharacters: 40000, transcriptLines: 500 } });
      if (request.method === 'GET' && url.pathname === '/api/runs') return json(response, 200, { runs: store.list() });
      const runMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)$/i);
      if (request.method === 'GET' && runMatch) {
        const record = store.get(runMatch[1]);
        return record ? json(response, 200, record) : json(response, 404, { error: 'Run not found' });
      }
      const exportMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/export$/i);
      if (request.method === 'GET' && exportMatch) {
        const record = store.get(exportMatch[1]);
        if (!record) return json(response, 404, { error: 'Run not found' });
        if (url.searchParams.get('format') === 'markdown') return download(response, artifactMarkdown(record), `${safeFilename(record.title)}-${record.id.slice(0, 8)}.md`, 'text/markdown; charset=utf-8');
        return download(response, JSON.stringify(record.artifact || { status: record.status, review: record.review, decision: record.decision }, null, 2), `${safeFilename(record.title)}-${record.id.slice(0, 8)}.json`, 'application/json; charset=utf-8');
      }
      if (request.method === 'POST') requireCsrf(request, csrf);
      if (portfolio && request.method === 'POST' && (url.pathname.startsWith('/api/fathom/') || /\/(google|notion|draft)$/.test(url.pathname))) throw new HttpError(403, 'External connections and delivery are disabled in the offline portfolio.');
      if (request.method === 'POST' && ['/api/fathom/connect', '/api/fathom/meetings', '/api/fathom/import'].includes(url.pathname)) {
        const input = await body(request);
        if (fathomBusy) throw new HttpError(409, 'A Fathom request is already running.');
        fathomBusy = true;
        try {
          if (url.pathname === '/api/fathom/connect') {
            const candidate = fathom.createFathomClient({ apiKey: input.apiKey });
            await candidate.listMeetings();
            fathom.saveFathomKey(input.apiKey);
            fathomClient = candidate;
            fathomMeetings.clear();
            return json(response, 200, { configured: true });
          }
          if (url.pathname === '/api/fathom/meetings') {
            const result = await getFathomClient().listMeetings({ cursor: input.cursor });
            if (!input.cursor) fathomMeetings.clear();
            for (const meeting of result.items) fathomMeetings.set(String(meeting.recording_id), meeting);
            return json(response, 200, { meetings: result.items.map(m => ({ id: String(m.recording_id), title: m.title, started_at: m.started_at })), nextCursor: result.next_cursor });
          }
          const meeting = fathomMeetings.get(String(input.id));
          if (!meeting) throw new HttpError(400, 'Refresh Fathom meetings and select one before importing.');
          const imported = await getFathomClient().transcript(input.id, meeting);
          return json(response, 200, imported);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          // Adapter errors are sanitized: never return a provider body or submitted key.
          throw new HttpError(400, error.message || 'Fathom request failed.');
        } finally { fathomBusy = false; }
      }
      if (request.method === 'POST' && url.pathname === '/api/runs') {
        const input = await body(request);
        let result;
        if (portfolio && input.mode !== 'demo') throw new HttpError(403, 'Choose a fictional demo scenario. Live extraction is disabled in the offline portfolio.');
        if (input.mode === 'demo') {
          try { result = require('./demo-fixtures').buildDemoReview(input.fixture, input.reviewer); }
          catch (error) { throw new HttpError(400, error.message); }
        }
        else if (input.mode === 'fixture') result = buildFixtureReview(input.fixture);
        else if (input.mode === 'brief') {
          if (input.processingPermission !== true || input.usagePermission !== true) throw new HttpError(400, 'Confirm processing and subscription use for this extraction');
          const { normalizeBrief, buildBriefReview } = require('./brief');
          const source = normalizeBrief(input);
          const extraction = await briefExtractor(source);
          result = { source, extraction, review: buildBriefReview(source, extraction) };
        }
        else if (input.mode === 'model') {
          if (input.processingPermission !== true) throw new HttpError(400, 'Confirm that this transcript may be sent to the configured model provider');
          if (input.usagePermission !== true) throw new HttpError(400, 'Confirm use of the ChatGPT subscription allowance for this model call');
          const config = manualConfig(input);
          const source = normalizeInput({ scenario: 'Manual transcript', title: input.title, started_at: input.started_at, transcript: input.transcript }, config);
          const extraction = await extractor(source);
          result = { source, extraction, review: buildReview(source, extraction) };
        } else throw new HttpError(400, 'Unknown run mode');
        const record = store.create(newRunRecord(result.source, result.extraction, result.review));
        return json(response, 201, record);
      }
      const decisionMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/decision$/i);
      const notionMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/notion$/i);
      if (request.method === 'POST' && notionMatch) {
        throw new HttpError(410, 'Notion delivery has been replaced by Google. Historical receipts are preserved.');
      }
      const googleMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/google$/i);
      if (request.method === 'POST' && googleMatch) {
        const input = await body(request);
        if (input.confirmDelivery !== true) throw new HttpError(400, 'Confirm delivery of approved projects to Google');
        if (!googleConfig.configured) throw new HttpError(400, 'Connect Google and set up its destinations first');
        if (googleSending) throw new HttpError(409, 'Google delivery is already running');
        const id = googleMatch[1];
        if (!store.get(id)) throw new HttpError(404, 'Run not found');
        googleSending = true;
        try { return json(response, 200, await require('./google-delivery').deliverGoogle(store, id, googleClient, googleConfig)); }
        finally { googleSending = false; }
      }
      const draftMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/draft$/i);
      if (request.method === 'POST' && draftMatch) {
        const id = draftMatch[1];
        const record = store.get(id);
        if (!record?.artifact?.email_draft) throw new HttpError(400, 'No saved clarification draft');
        const input = await body(request);
        if (input.processingPermission !== true || input.usagePermission !== true) throw new HttpError(400, 'Confirm processing and subscription use for this draft');
        if (drafting.has(id)) throw new HttpError(409, 'Draft generation already running');
        drafting.add(id);
        try { return json(response, 200, store.saveDraft(id, await draftRefiner(record.artifact))); }
        finally { drafting.delete(id); }
      }
      if (request.method === 'POST' && decisionMatch) {
        const record = store.get(decisionMatch[1]);
        if (!record) return json(response, 404, { error: 'Run not found' });
        if (record.decision) throw new HttpError(409, 'This review already has a final decision');
        const input = await body(request);
        const result = record.review.kind === 'client_briefs' ? require('./brief').decideBrief(record.review, input) : applyDecision(record.review, input);
        return json(response, 200, store.decide(record.id, result.status, result.decision, result.artifact));
      }
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error(error);
      return json(response, status, { error: error.message || 'Unexpected error' });
    }
  });

  return { server, store, csrf, close: () => new Promise(resolve => server.close(() => { store.close(); resolve(); })) };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function setHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function requireCsrf(request, expected) {
  if (request.headers['x-csrf-token'] !== expected) throw new HttpError(403, 'Invalid session token; refresh the page');
}

async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Request is too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw new HttpError(400, 'Request body must be valid JSON'); }
}

function json(response, status, value) {
  const payload = Buffer.from(JSON.stringify(value));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length });
  response.end(payload);
}

function sendFile(response, filename, contentType) {
  const payload = fs.readFileSync(path.join(publicDir, filename));
  response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': payload.length });
  response.end(payload);
}

function download(response, content, filename, contentType) {
  const payload = Buffer.from(content);
  response.writeHead(200, { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': payload.length });
  response.end(payload);
}

function safeFilename(value) {
  return String(value).normalize('NFKD').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'meeting-review';
}

if (require.main === module) {
  const port = Number(process.env.FDE_WORKFLOW_PORT || 3211);
  const host = '127.0.0.1';
  const app = createApp({ portfolio: !process.argv.includes('--connected') });
  app.server.listen(port, host, () => console.log(`FDE Meeting Review is running at http://${host}:${port}`));
  const shutdown = () => app.close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
