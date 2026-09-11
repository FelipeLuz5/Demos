'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RunStore } = require('./db');
const { normalizeInput, buildReview } = require('./core');
const { DEFAULT_OPENCLAW_MODEL, OPENCLAW_PROVIDER, extractWithOpenClaw } = require('./model');
const { fixtureNames, buildFixtureReview, manualConfig, newRunRecord, applyDecision, artifactMarkdown } = require('./workflow');

const publicDir = path.join(__dirname, '..', 'public');
const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/consent.js': ['consent.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8']
};

function createApp(options = {}) {
  const database = options.database || path.join(__dirname, '..', 'data', 'workflow.sqlite');
  const store = options.store || new RunStore(database);
  const extractor = options.extractor || (async () => { throw new HttpError(503, 'Live extraction is disabled in this portfolio demo. Choose a saved scenario.'); });
  const csrf = crypto.randomBytes(24).toString('base64url');

  const server = http.createServer(async (request, response) => {
    setHeaders(response);
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && staticFiles[url.pathname]) return sendFile(response, ...staticFiles[url.pathname]);
      if (request.method === 'GET' && url.pathname === '/api/bootstrap') return json(response, 200, { csrf, fixtures: fixtureNames(), model: { configured: false, provider: OPENCLAW_PROVIDER, name: process.env.FDE_OPENCLAW_MODEL || DEFAULT_OPENCLAW_MODEL }, limits: { transcriptCharacters: 40000, transcriptLines: 500 } });
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
      if (request.method === 'POST' && url.pathname === '/api/runs') {
        const input = await body(request);
        let result;
        if (input.mode === 'fixture') result = buildFixtureReview(input.fixture);
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
      if (request.method === 'POST' && decisionMatch) {
        const record = store.get(decisionMatch[1]);
        if (!record) return json(response, 404, { error: 'Run not found' });
        if (record.decision) throw new HttpError(409, 'This review already has a final decision');
        const input = await body(request);
        const result = applyDecision(record.review, input);
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
  const port = Number(process.env.FDE_WORKFLOW_PORT || 3210);
  const host = '127.0.0.1';
  const app = createApp();
  app.server.listen(port, host, () => console.log(`FDE Meeting Review is running at http://${host}:${port}`));
  const shutdown = () => app.close().finally(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
