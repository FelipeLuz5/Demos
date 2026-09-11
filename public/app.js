'use strict';

const state = { csrf: '', runs: [], current: null, bootstrap: null };
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.method === 'POST' ? { 'X-CSRF-Token': state.csrf } : {}), ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function init() {
  state.bootstrap = await api('/api/bootstrap');
  state.csrf = state.bootstrap.csrf;
  $('#model-status').textContent = 'Offline portfolio demo · no account required';
  renderFixtures();
  await loadRuns();
}

async function loadRuns(selectId) {
  const result = await api('/api/runs');
  state.runs = result.runs;
  $('#run-list').innerHTML = state.runs.length ? state.runs.map(run => `<button class="run-link ${run.id === selectId ? 'active' : ''}" data-id="${run.id}"><strong>${esc(run.title)}</strong><small><i class="mini-dot ${esc(run.status)}"></i>${esc(labelStatus(run.status))} · ${formatDate(run.created_at)}</small></button>`).join('') : '<div class="notice muted">No saved reviews yet.</div>';
  document.querySelectorAll('.run-link').forEach(button => button.addEventListener('click', () => openRun(button.dataset.id)));
}

function renderFixtures() {
  $('#fixture-options').innerHTML = state.bootstrap.fixtures.map((fixture, index) => `<label class="fixture-option"><input type="radio" name="fixture" value="${esc(fixture.id)}" ${index === 0 ? 'checked' : ''}><span><strong>${esc(fixture.label)}</strong><small>${esc(fixture.description)}</small></span></label>`).join('');
}

function showIntake() {
  FdeConsent.clear($('#manual-form'));
  $('#run-status').className = 'notice muted hidden';
  $('#run-status').textContent = '';
  $('#welcome').classList.add('hidden');
  $('#review').classList.add('hidden');
  $('#intake').classList.remove('hidden');
  $('#page-title').textContent = 'New meeting review';
}

function closeIntake() {
  $('#intake').classList.add('hidden');
  if (state.current) $('#review').classList.remove('hidden');
  else $('#welcome').classList.remove('hidden');
}

async function openRun(id) {
  try {
    state.current = await api(`/api/runs/${id}`);
    $('#welcome').classList.add('hidden');
    $('#intake').classList.add('hidden');
    $('#review').classList.remove('hidden');
    $('#page-title').textContent = state.current.title;
    renderReview(state.current);
    await loadRuns(id);
  } catch (error) { toast(error.message); }
}

function evidence(items) {
  return (items || []).map(item => `<div class="evidence"><strong>Line ${item.line}</strong><br>${esc(item.quote)}</div>`).join('');
}

function renderReview(record) {
  const review = record.review;
  const final = Boolean(record.decision);
  const project = review.project ? `${review.project.client} / ${review.project.name}` : 'Unresolved project';
  const blockers = review.blockers.length ? review.blockers.map(item => `<div class="notice blocker">${esc(item)}</div>`).join('') : '<div class="notice muted">No package-level blockers.</div>';
  const tasks = review.candidates.length ? review.candidates.map(task => `<article class="task-card"><div class="task-head"><h4>${esc(task.title)}</h4><span>${esc(task.owner)} · due ${esc(task.due)}</span></div>${evidence(task.evidence)}${task.dependencies.length ? `<div class="reasons">Depends on: ${task.dependencies.map(dep => esc(dep.description)).join(', ')}</div>` : ''}</article>`).join('') : '<div class="notice muted">No eligible commitments.</div>';
  const unresolved = review.unresolved.length ? review.unresolved.map(item => `<article class="task-card"><div class="task-head"><h4>${esc(item.text)}</h4></div><div class="reasons">${(item.reasons || []).map(esc).join(' · ')}</div>${evidence(item.evidence)}</article>`).join('') : '<div class="notice muted">Nothing excluded or unresolved.</div>';
  const suggestions = review.suggestions.length ? review.suggestions.map(item => `<article class="task-card"><h4>${esc(item.text)}</h4>${evidence(item.evidence)}</article>`).join('') : '<div class="notice muted">No suggestions extracted.</div>';
  const decisionPanel = final ? renderDecision(record) : `<div class="decision-box"><h3>Record your decision</h3><p>Approval covers every eligible commitment above. Excluded actions and suggestions remain excluded. Notes do not change this review package.</p><label class="check"><input id="confirm-evidence" type="checkbox"> I reviewed the source evidence for every eligible commitment.</label><label>Decision notes<textarea id="decision-notes" rows="3" maxlength="2000" placeholder="Optional"></textarea></label><div class="decision-actions"><button class="primary" data-decision="Approve" ${review.blockers.length ? 'disabled title="Resolve blockers through a new source review"' : ''}>Approve all eligible commitments</button><button class="secondary" data-decision="Request clarification">Request clarification</button><button class="danger" data-decision="Reject">Reject</button></div></div>`;
  $('#review').innerHTML = `<div class="review-heading"><div><span class="status-pill ${esc(record.status)}">${esc(labelStatus(record.status))}</span><h2>${esc(record.title)}</h2><div class="review-meta"><span>${esc(project)}</span><span>${esc(review.started_at)}</span><span>Review expires ${formatDate(review.expires_at)}</span></div></div><button class="primary" id="another-review">+ New review</button></div><div class="summary-grid"><div class="metric"><b>${review.candidates.length}</b><span>Eligible</span></div><div class="metric"><b>${review.unresolved.length}</b><span>Excluded</span></div><div class="metric"><b>${review.blockers.length}</b><span>Blockers</span></div><div class="metric"><b>${review.suggestions.length}</b><span>Suggestions</span></div></div><section class="section"><h3>Approval blockers</h3>${blockers}</section><section class="section"><h3>Eligible commitments</h3>${tasks}</section><section class="section"><h3>Excluded and unresolved</h3>${unresolved}</section><section class="section"><h3>Suggestions</h3>${suggestions}</section>${decisionPanel}<details><summary>Source transcript and integrity record</summary><pre>${esc(review.lines.map(line => `${line.line}. ${line.text}`).join('\n'))}</pre><p class="review-meta"><span>Source SHA-256: ${esc(record.source_hash)}</span><span>Review SHA-256: ${esc(record.review_digest)}</span></p></details>`;
  $('#another-review').addEventListener('click', showIntake);
  document.querySelectorAll('[data-decision]').forEach(button => button.addEventListener('click', () => submitDecision(button.dataset.decision)));
}

function renderDecision(record) {
  const approval = record.decision.approval;
  const errors = approval.errors.length ? `<div class="notice blocker">${approval.errors.map(esc).join('<br>')}</div>` : '';
  return `<div class="decision-box"><span class="status-pill ${esc(record.status)}">Final decision</span><h3>${esc(approval.decision)}</h3><p>Recorded by ${esc(approval.reviewer)} on ${formatDate(approval.at)}. Approval gate passed: <strong>${approval.passed ? 'yes' : 'no'}</strong>.</p>${approval.notes ? `<div class="notice muted">${esc(approval.notes)}</div>` : ''}${errors}<div class="export-row"><a href="/api/runs/${record.id}/export?format=json">Download JSON</a><a href="/api/runs/${record.id}/export?format=markdown">Download Markdown</a></div></div>`;
}

async function submitDecision(decision) {
  const confirmed = $('#confirm-evidence').checked;
  if (decision === 'Approve' && !confirmed) return toast('Confirm that you reviewed the evidence before approval.');
  try {
    document.querySelector('.decision-box').classList.add('loading');
    const record = await api(`/api/runs/${state.current.id}/decision`, { method: 'POST', body: JSON.stringify({ decision, confirmEvidence: confirmed, notes: $('#decision-notes').value }) });
    state.current = record;
    renderReview(record);
    await loadRuns(record.id);
    toast(`Decision recorded: ${labelStatus(record.status)}.`);
  } catch (error) { toast(error.message); renderReview(state.current); }
}

$('#fixture-form').addEventListener('submit', async event => {
  event.preventDefault();
  const fixture = new FormData(event.currentTarget).get('fixture');
  await createRun({ mode: 'fixture', fixture });
});

$('#manual-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const permissions = FdeConsent.consume(event.currentTarget);
  const list = value => String(value || '').split(/[\n,]/).map(item => item.trim()).filter(Boolean);
  await createRun({ mode: 'model', title: data.get('title'), started_at: data.get('started_at'), reviewer: data.get('reviewer'), client: data.get('client'), project: data.get('project'), aliases: list(data.get('aliases')), owners: list(data.get('owners')), approved_facts: data.get('approved_facts'), transcript: data.get('transcript'), ...permissions });
});

async function createRun(input) {
  const status = $('#run-status');
  const started = Date.now();
  let timer;
  try {
    $('#intake').classList.add('loading');
    if (input.mode === 'model') {
      status.className = 'notice muted';
      const update = () => { status.textContent = `OpenClaw extraction is running · ${Math.floor((Date.now() - started) / 1000)}s elapsed`; };
      update();
      timer = setInterval(update, 1000);
    }
    const record = await api('/api/runs', { method: 'POST', body: JSON.stringify(input) });
    state.current = record;
    $('#intake').classList.remove('loading');
    await openRun(record.id);
    toast('Review package saved locally.');
  } catch (error) {
    $('#intake').classList.remove('loading');
    status.className = 'notice blocker';
    status.textContent = error.message;
    toast('Extraction failed. See the message in the form.');
  } finally { clearInterval(timer); }
}

function labelStatus(status) {
  return ({ review: 'Ready for review', approved: 'Approved', rejected: 'Rejected', clarification: 'Clarification requested', blocked: 'Blocked', error: 'Error' })[status] || status;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(+date) ? esc(value) : date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

let toastTimer;
function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), 3800);
}

$('#new-run').addEventListener('click', showIntake);
$('#hero-new').addEventListener('click', showIntake);
$('#close-intake').addEventListener('click', closeIntake);
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
  $('#fixture-form').classList.toggle('hidden', tab.dataset.tab !== 'fixtures');
  $('#manual-form').classList.toggle('hidden', tab.dataset.tab !== 'manual');
}));

init().catch(error => toast(error.message));
