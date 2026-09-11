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

  close() { this.db.close(); }
}

const json = value => value == null ? null : JSON.stringify(value);
const parse = value => value == null ? null : JSON.parse(value);

module.exports = { RunStore };
