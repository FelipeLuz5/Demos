'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

class RunStore {
  constructor(filename) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS google_operations (
        operation_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL,
        value_json TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notion_client_routes (route_key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notion_deliveries (
        delivery_key TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        state TEXT NOT NULL,
        page_id TEXT,
        page_url TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('review', 'approved', 'rejected', 'clarification', 'blocked', 'error')),
        scenario TEXT NOT NULL,
        title TEXT NOT NULL,
        source_hash TEXT,
        review_digest TEXT,
        source_json TEXT,
        extraction_json TEXT,
        review_json TEXT,
        decision_json TEXT,
        artifact_json TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run_id ON events(run_id, id);
    `);
    this.insertRun = this.db.prepare(`INSERT INTO runs (id, created_at, updated_at, status, scenario, title, source_hash, review_digest, source_json, extraction_json, review_json, decision_json, artifact_json, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.selectRun = this.db.prepare('SELECT * FROM runs WHERE id = ?');
    this.selectRuns = this.db.prepare('SELECT id, created_at, updated_at, status, scenario, title, source_hash, review_digest, error FROM runs ORDER BY created_at DESC LIMIT ?');
    this.selectEvents = this.db.prepare('SELECT id, at, type, detail_json FROM events WHERE run_id = ? ORDER BY id');
    this.insertEvent = this.db.prepare('INSERT INTO events (run_id, at, type, detail_json) VALUES (?, ?, ?, ?)');
    this.updateDecision = this.db.prepare('UPDATE runs SET updated_at = ?, status = ?, decision_json = ?, artifact_json = ?, error = NULL WHERE id = ? AND decision_json IS NULL');
  }

  create(record) {
    this.insertRun.run(record.id, record.created_at, record.created_at, record.status, record.scenario, record.title, record.source_hash || null, record.review_digest || null, json(record.source), json(record.extraction), json(record.review), null, null, record.error || null);
    this.event(record.id, 'run.created', { status: record.status, source_hash: record.source_hash, review_digest: record.review_digest });
    return this.get(record.id);
  }

  list(limit = 100) {
    return this.selectRuns.all(Math.max(1, Math.min(200, Number(limit) || 100))).map(row => ({ ...row }));
  }

  get(id) {
    const row = this.selectRun.get(id);
    if (!row) return null;
    return {
      ...row,
      source: parse(row.source_json), extraction: parse(row.extraction_json), review: parse(row.review_json), decision: parse(row.decision_json), artifact: parse(row.artifact_json),
      events: this.selectEvents.all(id).map(event => ({ ...event, detail: parse(event.detail_json) }))
    };
  }

  decide(id, status, decision, artifact) {
    const at = new Date().toISOString();
    const result = this.updateDecision.run(at, status, json(decision), json(artifact), id);
    if (result.changes !== 1) throw new Error('This review already has a final decision');
    this.event(id, 'review.decided', { status, decision: decision.approval?.decision, passed: decision.approval?.passed === true });
    return this.get(id);
  }

  event(runId, type, detail) {
    this.insertEvent.run(runId, new Date().toISOString(), type, json(detail));
  }

  saveDraft(id, draft) {
    const record = this.get(id);
    if (!record?.artifact?.email_draft) throw new Error('No saved draft');
    record.artifact.email_draft = draft;
    this.db.prepare('UPDATE runs SET artifact_json = ?, updated_at = ? WHERE id = ?').run(json(record.artifact), new Date().toISOString(), id);
    this.event(id, 'clarification.drafted', { method: draft.method, sent: false });
    return this.get(id);
  }

  notionDelivery(key) { return this.db.prepare('SELECT * FROM notion_deliveries WHERE delivery_key = ?').get(key); }
  getRoute(key) { const row = this.db.prepare('SELECT value_json FROM notion_client_routes WHERE route_key=?').get(key); return row ? JSON.parse(row.value_json) : null; }
  saveRoute(key, value) { this.db.prepare('INSERT INTO notion_client_routes(route_key,value_json) VALUES (?,?) ON CONFLICT(route_key) DO UPDATE SET value_json=excluded.value_json').run(key,JSON.stringify(value)); }
  claimNotion(key, runId) {
    return this.db.prepare("INSERT OR IGNORE INTO notion_deliveries(delivery_key,run_id,state,updated_at) VALUES (?,?,'uncertain',?)").run(key, runId, new Date().toISOString()).changes === 1;
  }
  finishNotion(key, page) {
    this.db.prepare("UPDATE notion_deliveries SET state='delivered',page_id=?,page_url=?,updated_at=? WHERE delivery_key=?").run(page.id, page.url, new Date().toISOString(), key);
  }
  releaseNotion(key) { this.db.prepare("DELETE FROM notion_deliveries WHERE delivery_key=? AND state='uncertain'").run(key); }
  saveDelivery(id, delivery) {
    const record = this.get(id);
    record.artifact.delivery = delivery;
    record.artifact.external_writes_performed = delivery.pages.length > 0 || delivery.structure_created ? true : delivery.status === 'uncertain' ? null : false;
    record.artifact.local_only = delivery.pages.length === 0 && !delivery.structure_created && delivery.status !== 'uncertain';
    this.db.prepare('UPDATE runs SET artifact_json=?,updated_at=? WHERE id=?').run(json(record.artifact), new Date().toISOString(), id);
    this.event(id, 'notion.delivery', delivery);
    return this.get(id);
  }

  googleOperation(key) {
    const row = this.db.prepare('SELECT * FROM google_operations WHERE operation_key=?').get(key);
    return row ? { ...row, value: parse(row.value_json) } : null;
  }
  claimGoogle(key, runId) {
    return this.db.prepare("INSERT OR IGNORE INTO google_operations(operation_key,run_id,state,updated_at) VALUES (?,?,'uncertain',?)").run(key, runId, new Date().toISOString()).changes === 1;
  }
  finishGoogle(key, value) {
    this.db.prepare("UPDATE google_operations SET state='delivered',value_json=?,updated_at=? WHERE operation_key=?").run(json(value), new Date().toISOString(), key);
  }
  releaseGoogle(key) { this.db.prepare("DELETE FROM google_operations WHERE operation_key=? AND state='uncertain'").run(key); }
  beginGoogleDelivery(id, delivery) {
    // Atomic compare-and-set also binds competing app processes before either can write externally.
    const result = this.db.prepare("UPDATE runs SET artifact_json=json_set(artifact_json,'$.google_delivery',json(?),'$.external_writes_performed',json(CASE WHEN json_extract(artifact_json,'$.external_writes_performed')=1 THEN 'true' ELSE 'null' END),'$.local_only',json('false')),updated_at=? WHERE id=? AND json_type(artifact_json,'$.google_delivery') IS NULL").run(json(delivery), new Date().toISOString(), id);
    const current = this.get(id)?.artifact?.google_delivery;
    if (!current || current.root_folder_id !== delivery.root_folder_id || current.calendar_id !== delivery.calendar_id) throw new Error('Google destination changed. Restore the original connection to reconcile this delivery.');
    if (result.changes) this.event(id, 'google.delivery.started', { root_folder_id: delivery.root_folder_id, calendar_id: delivery.calendar_id });
  }
  saveGoogleDelivery(id, delivery) {
    const record = this.get(id);
    record.artifact.google_delivery = delivery;
    const priorWrites = record.artifact.external_writes_performed;
    record.artifact.external_writes_performed = priorWrites === true || delivery.writes_performed || delivery.projects.some(p => p.document_url || p.folder_url) ? true : delivery.status === 'uncertain' || priorWrites === null ? null : false;
    record.artifact.local_only = record.artifact.external_writes_performed === false;
    this.db.prepare('UPDATE runs SET artifact_json=?,updated_at=? WHERE id=?').run(json(record.artifact), new Date().toISOString(), id);
    this.event(id, 'google.delivery', delivery);
    return this.get(id);
  }

  close() { this.db.close(); }
}

const json = value => value == null ? null : JSON.stringify(value);
const parse = value => value == null ? null : JSON.parse(value);

module.exports = { RunStore };
