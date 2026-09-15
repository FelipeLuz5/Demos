'use strict';

const state = { csrf: '', runs: [], current: null, bootstrap: null, google: null, delivering: false };
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
  state.google = await api('/api/google/status').catch(() => null);
  $('#google-status').textContent = state.google?.configured ? 'Google delivery ready' : 'Set up Google delivery';
  $('#model-status').textContent = state.bootstrap.model.configured ? `${state.bootstrap.model.provider} ready | ${state.bootstrap.model.name} | thinking ${state.bootstrap.model.thinking}` : `Offline mode | ${state.bootstrap.model.name} not configured`;
  if (state.bootstrap.portfolio) {
    $('#model-status').textContent = 'Offline portfolio | Fictional examples';
    $('#google-status').textContent = 'Local exports only';
    $('#google-status').removeAttribute('href');
    $('.local-card small').textContent = 'Reviews stay on this PC. No model calls, account connections or external delivery.';
    $('.hero p').textContent = 'Inspect deliverables, requirements and deadlines from a fictional meeting. Select projects, check their source evidence, and download the briefs you approve.';
    $('.flow-card').innerHTML = '<div class="flow-step"><b>01</b><span><strong>Fictional meeting</strong><small>Saved extraction, no AI call</small></span></div><div class="flow-line"></div><div class="flow-step"><b>02</b><span><strong>Evidence review</strong><small>Inspect proposals and source quotations</small></span></div><div class="flow-line"></div><div class="flow-step"><b>03</b><span><strong>Your decision</strong><small>Select and approve project briefs</small></span></div><div class="flow-line"></div><div class="flow-step"><b>04</b><span><strong>Local export</strong><small>Markdown and JSON project briefs</small></span></div>';
    $('#demo-form').classList.remove('hidden');
    $('#demo-fixture').innerHTML = state.bootstrap.demoFixtures.map(f => `<option value="${esc(f.id)}">${esc(f.label)}</option>`).join('');
    updateDemoDescription();
  } else {
    $('#manual-form').classList.remove('hidden');
    $('#fathom-panel').classList.remove('hidden');
  }
  $('#new-run').disabled = false;
  $('#hero-new').disabled = false;
  await loadRuns();
}

async function loadRuns(selectId) {
  const result = await api('/api/runs');
  state.runs = result.runs;
  $('#run-list').innerHTML = state.runs.length ? state.runs.map(run => `<button class="run-link ${run.id === selectId ? 'active' : ''}" data-id="${run.id}"><strong>${esc(run.title)}</strong><small><i class="mini-dot ${esc(run.status)}"></i>${esc(labelStatus(run.status))} | ${formatDate(run.created_at)}</small></button>`).join('') : '<div class="notice muted">No saved reviews yet.</div>';
  document.querySelectorAll('.run-link').forEach(button => button.addEventListener('click', () => openRun(button.dataset.id)));
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
    $('#page-title').textContent = 'Project review';
    renderReview(state.current);
    await loadRuns(id);
  } catch (error) { toast(error.message); }
}

function evidence(items) {
  return (items || []).map(item => `<div class="evidence"><strong>Line ${item.line}</strong><br>${esc(item.quote)}</div>`).join('');
}

function exportLinks(record) {
  return `<div class="export-row"><a href="/api/runs/${encodeURIComponent(record.id)}/export?format=json">Download JSON</a><a href="/api/runs/${encodeURIComponent(record.id)}/export?format=markdown">Download Markdown</a></div>`;
}

function sourceDetails(items, label = 'View source') {
  if (!items?.length) return '';
  return `<details class="source-detail"><summary>${esc(label)}</summary>${evidence(items)}</details>`;
}

function briefItems(items) {
  return `<ul class="brief-list">${(items || []).map(item => `<li><span>${esc(item.text)}</span>${sourceDetails(item.evidence)}</li>`).join('')}</ul>`;
}

function projectCard(proposal, final, approvedIds) {
  const selected = approvedIds.has(proposal.id);
  return `<article class="project-card ${proposal.status === 'needs_decision' && !final ? 'needs-decision' : ''}">
    <div class="project-top"><div><p class="project-client">${esc(proposal.client || 'Client unspecified')}</p><h3>${esc(proposal.name)}</h3></div>${final ? `<span class="project-outcome">${selected ? 'Approved' : 'Not approved'}</span>` : ''}</div>
    <div class="project-date"><span>Delivery: <strong>${esc(proposal.delivery_date || 'Not agreed')}</strong></span>${sourceDetails(proposal.date_evidence)}</div>
    <p class="project-description">${esc(proposal.description)}</p>
    <div class="brief-columns"><div><h4>Deliverables</h4>${briefItems(proposal.deliverables)}</div>${proposal.requirements?.length ? `<div><h4>Requirements</h4>${briefItems(proposal.requirements)}</div>` : ''}</div>
    <div class="project-footer">${sourceDetails(proposal.evidence, 'View project evidence')}${!final ? `<label class="check project-select"><input type="checkbox" data-proposal-id="${esc(proposal.id)}"> Select this project for approval<span class="sr-only">: ${esc(proposal.name)}</span></label>` : ''}</div>
  </article>`;
}

function updateApprovalSelection() {
  const count = document.querySelectorAll('[data-proposal-id]:checked').length;
  const label = $('#selection-count');
  if (label) label.textContent = `${count} project${count === 1 ? '' : 's'} selected`;
  const button = $('[data-decision="Approve projects"]');
  if (button) button.disabled = !count || !$('#confirm-evidence')?.checked || Boolean(state.current?.review?.blockers?.length);
}

function renderReview(record) {
  const review = record.review;
  if (review.kind !== 'client_briefs') {
    $('#review').innerHTML = `<div class="review-heading"><h2>${esc(record.title)}</h2><button class="secondary" id="another-review">New review</button></div><p class="quiet-copy">This saved task review is read-only. Start a new review to create client project briefs.</p>${exportLinks(record)}`;
    $('#another-review').addEventListener('click', showIntake);
    return;
  }
  const final = Boolean(record.decision);
  const proposals = review.proposals || [];
  const approvedIds = new Set((record.artifact?.projects || []).map(project => project.id));
  const section = (status, title) => {
    const items = proposals.filter(p => p.status === status);
    return items.length ? `<section class="proposal-group"><div class="group-heading"><h3>${title}</h3><span>${items.length}</span></div>${items.map(p => projectCard(p, final, approvedIds)).join('')}</section>` : '';
  };
  const blockers = (review.blockers || []).map(item => `<div class="notice blocker" role="alert">${esc(item)}</div>`).join('');
  const panel = final ? renderDecision(record) : `<section class="decision-box approval-panel"><div class="approval-heading"><h3>Ready to approve?</h3><span id="selection-count" aria-live="polite">0 projects selected</span></div><label class="check"><input id="confirm-evidence" type="checkbox"> I reviewed the source evidence and approve the selected project briefs.</label><details class="review-details"><summary>Add a decision note</summary><label class="sr-only" for="decision-notes">Decision notes</label><textarea id="decision-notes" rows="3" maxlength="2000" placeholder="Optional note"></textarea></details><div class="decision-actions"><button class="primary" data-decision="Approve projects" disabled>Approve selected</button><button class="quiet-button" data-decision="Reject">Discard all proposals</button></div></section>`;
  $('#review').innerHTML = `<div class="review-heading"><div><span class="status-pill ${esc(record.status)}">${esc(labelStatus(record.status))}</span><h2>${esc(record.title)}</h2><p class="quiet-copy">${proposals.length} project${proposals.length === 1 ? '' : 's'} &middot; ${formatDate(review.started_at)}</p></div><button class="secondary" id="another-review">New review</button></div>${blockers}${section('confirmed', final ? 'Confirmed in the meeting' : 'Confirmed proposals')}${section('needs_decision', final ? 'Required reviewer judgment' : 'Needs your decision')}${!proposals.length ? '<p class="empty-review">No project proposals were found in this transcript.</p>' : ''}${panel}<details class="review-details transcript-details"><summary>Full transcript &amp; review details</summary><pre>${esc((review.lines || []).map(line => `${line.line}. ${line.text}`).join('\n'))}</pre><div class="review-meta"><span>Source SHA-256: ${esc(record.source_hash)}</span><span>Review SHA-256: ${esc(record.review_digest)}</span>${!final && review.expires_at ? `<span>Review expires ${formatDate(review.expires_at)}</span>` : ''}</div></details>`;
  $('#another-review').addEventListener('click', showIntake);
  document.querySelectorAll('[data-decision]').forEach(button => button.addEventListener('click', () => submitDecision(button.dataset.decision)));
  document.querySelectorAll('[data-proposal-id]').forEach(input => input.addEventListener('change', updateApprovalSelection));
  $('#confirm-evidence')?.addEventListener('change', updateApprovalSelection);
  $('#google-delivery')?.addEventListener('click', deliverToGoogle);
}

function historicalNotionDelivery(record) {
  const delivery = record.artifact?.delivery;
  if (delivery?.destination !== 'notion') return '';
  const pages = (delivery.pages || []).map(page => {
    try {
      const url = new URL(page.url);
      if (url.protocol !== 'https:' || !['notion.so', 'www.notion.so', 'app.notion.com'].includes(url.hostname) || url.username || url.password || url.port) return '';
      return `<li><a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(page.project || 'Open project in Notion')}</a></li>`;
    } catch { return ''; }
  }).filter(Boolean).join('');
  return `<details><summary>Historical Notion receipt (read-only)</summary><p>Recorded status: ${esc(delivery.status || 'Unknown')}. This record is preserved; sending to Google creates separate Google records.</p>${delivery.error ? `<p>${esc(delivery.error)}</p>` : ''}${pages ? `<ul>${pages}</ul>` : ''}</details>`;
}

function googleLink(value, label, hostnames) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !hostnames.includes(url.hostname) || url.username || url.password || url.port) return '';
    return `<a href="${esc(url.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  } catch { return ''; }
}

function googleDelivery(record) {
  if (!record.artifact?.projects?.length || !record.decision?.approval?.passed) return '';
  if (state.bootstrap?.portfolio) return '<p class="notice muted">Offline portfolio: approved briefs are available as local downloads. Google delivery is implemented in the connected edition; no external delivery occurs here.</p>';
  const delivery = record.artifact.google_delivery || {};
  const projects = (delivery.projects || []).map(project => {
    const links = [googleLink(project.folder_url, 'Client folder', ['drive.google.com']), googleLink(project.document_url, 'Project brief', ['docs.google.com']), googleLink(project.calendar_url, 'Deadline', ['calendar.google.com', 'www.google.com'])].filter(Boolean).join(' | ');
    const calendarStatus = ({ delivered: 'Deadline created', skipped: 'No agreed date - no calendar event', pending: 'Calendar delivery pending' })[project.calendar_status] || 'Calendar status not recorded';
    return `<li><strong>${esc(project.project || 'Project')}</strong>${links ? `<div>${links}</div>` : ''}<small>${esc(calendarStatus)}</small></li>`;
  }).join('');
  const status = ({ delivered: 'Approved projects delivered to Google.', in_progress: 'A Google send was started. Check its delivery receipts to recover any interrupted work.', failed: 'Google delivery failed. Completed items are preserved.', uncertain: 'Google delivery needs checking. Check Google delivery to reconcile existing items; remaining delivery stages may then complete. Items with an uncertain creation result will not be recreated.' })[delivery.status] || (state.google?.configured ? 'Ready to send approved project briefs to Google.' : state.google === null ? 'Google connection status is unavailable. Refresh to check again.' : 'Google delivery is not configured yet.');
  const destinationChanged = Boolean(state.google?.configured && ((delivery.root_folder_id && delivery.root_folder_id !== state.google.rootFolderId) || (delivery.calendar_id && delivery.calendar_id !== state.google.calendarId)));
  const canSend = state.google?.configured && delivery.status !== 'delivered' && !destinationChanged;
  const label = ['uncertain', 'in_progress'].includes(delivery.status) ? 'Check Google delivery' : delivery.status === 'failed' ? 'Retry Google delivery' : record.artifact.delivery?.destination === 'notion' ? 'Create Google copies of these approved projects' : 'Send approved projects to Google';
  const button = canSend ? `<button class="primary" id="google-delivery" ${state.delivering ? 'disabled' : ''}>${state.delivering ? 'Checking and completing Google delivery...' : label}</button>` : '';
  const rootFolderId = delivery.root_folder_id || state.google?.rootFolderId;
  const calendarId = delivery.calendar_id || state.google?.calendarId;
  return `<div class="notice muted google-delivery"><h4>Google Drive, Docs &amp; Calendar</h4><p>${esc(status)}</p><p>Creates a client folder and a Google Doc per project. Agreed delivery dates become all-day calendar deadlines linked to the brief. No invitations are sent.</p><details class="review-details delivery-destinations"><summary>Connection details</summary><p><strong>Drive folder:</strong> ${esc(rootFolderId || 'Not configured')}</p><p><strong>Calendar:</strong> ${esc(calendarId || 'Not configured')}</p></details>${destinationChanged ? '<p class="delivery-error">Google destination changed. Restore the original connection to reconcile this delivery.</p>' : ''}${delivery.error ? `<p class="delivery-error">${esc(delivery.error)}</p>` : ''}${projects ? `<ul class="delivery-projects">${projects}</ul>` : ''}${!state.google?.configured ? `<p><a href="/google-setup.html">Set up your Google connection</a></p>${state.google?.error ? `<p>${esc(state.google.error)}</p>` : ''}` : ''}${button}</div>`;
}

function renderDecision(record) {
  const approval = record.decision.approval;
  const errors = (approval.errors || []).length ? `<div class="notice blocker">${approval.errors.map(esc).join('<br>')}</div>` : '';
  return `<section class="decision-box decision-result"><h3>${record.artifact ? `${record.artifact.projects?.length || 0} project briefs approved` : esc(approval.decision)}</h3><p class="quiet-copy">Recorded by ${esc(approval.reviewer)} &middot; ${formatDate(approval.at)}</p>${approval.notes ? `<details class="review-details"><summary>Decision note</summary><p>${esc(approval.notes)}</p></details>` : ''}${errors}</section>${googleDelivery(record)}<details class="review-details"><summary>Downloads &amp; history</summary>${exportLinks(record)}${historicalNotionDelivery(record)}</details>`;
}

async function deliverToGoogle() {
  if (state.delivering || !state.current) return;
  const id = state.current.id;
  state.delivering = true;
  renderReview(state.current);
  try {
    const record = await api(`/api/runs/${encodeURIComponent(id)}/google`, { method: 'POST', body: JSON.stringify({ confirmDelivery: true }) });
    if (state.current?.id === id) state.current = record;
    toast(record.artifact?.google_delivery?.status === 'delivered' ? 'Approved projects delivered to Google.' : 'Check the Google delivery status below.');
  } catch (error) {
    toast(error.message);
    // A write may have completed before the response failed. Reload its persisted status.
    try {
      const record = await api(`/api/runs/${encodeURIComponent(id)}`);
      if (state.current?.id === id) state.current = record;
    } catch { /* Keep the existing record; never automatically retry a write. */ }
  } finally {
    state.delivering = false;
    if (state.current) renderReview(state.current);
  }
}

async function submitDecision(decision) {
  const confirmed = $('#confirm-evidence').checked;
  const approvedProposalIds = [...document.querySelectorAll('[data-proposal-id]:checked')].map(input => input.dataset.proposalId);
  if (decision === 'Approve projects' && !approvedProposalIds.length) return toast('Select at least one project to approve.');
  if (decision === 'Approve projects' && !confirmed) return toast('Confirm that you reviewed the evidence before approval.');
  try {
    document.querySelector('.decision-box').classList.add('loading');
    const record = await api(`/api/runs/${state.current.id}/decision`, { method: 'POST', body: JSON.stringify({ decision, approvedProposalIds, confirmEvidence: confirmed, notes: $('#decision-notes').value }) });
    state.current = record;
    renderReview(record);
    await loadRuns(record.id);
    toast(`Decision recorded: ${labelStatus(record.status)}.`);
  } catch (error) { toast(error.message); document.querySelector('.decision-box')?.classList.remove('loading'); }
}

$('#manual-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const permissions = FdeConsent.consume(event.currentTarget);
  await createRun({ mode: 'brief', title: data.get('title'), started_at: data.get('started_at'), reviewer: data.get('reviewer'), client: data.get('client'), transcript: data.get('transcript'), ...permissions });
});

let importVersion = 0;
$('#transcript-file').addEventListener('change', async event => {
  const version = ++importVersion;
  const file = event.target.files[0];
  const form = $('#manual-form');
  FdeConsent.clear(form);
  if (!file) return;
  const status = $('#import-status');
  try {
    if (file.size > 512000) throw new Error('Choose a transcript smaller than 500 KB.');
    const parsed = parseTranscriptFile(await file.text(), file.name);
    if (version !== importVersion) return;
    for (const [name, value] of Object.entries(parsed)) {
      const field = form.elements.namedItem(name);
      if (field) field.value = value;
    }
    const missing = ['title', 'started_at'].filter(key => !parsed[key]);
    status.className = 'notice muted';
    status.textContent = missing.length ? `Imported ${file.name}. Please complete: ${missing.join(', ')}.` : `Imported ${file.name}. Meeting details are filled below. Check them, then extract.`;
  } catch (error) {
    if (version !== importVersion) return;
    status.className = 'notice blocker';
    status.textContent = `Import failed: ${error.message} Existing form values have been kept.`;
  }
});

async function createRun(input) {
  const status = $('#run-status');
  const started = Date.now();
  let timer;
  try {
    $('#intake').classList.add('loading');
    if (input.mode === 'brief') {
      status.className = 'notice muted';
      const update = () => { status.textContent = `OpenClaw extraction is running | ${Math.floor((Date.now() - started) / 1000)}s elapsed`; };
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
    toast('Review could not be created. See the message in the form.');
  } finally { clearInterval(timer); }
}

function labelStatus(status) {
  return ({ review: 'Ready for review', reviewed: 'Reviewed', partial: 'Partially approved', approved: 'Approved', rejected: 'Rejected', clarification: 'Clarification requested', blocked: 'Blocked', error: 'Error' })[status] || status;
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

function updateDemoDescription() {
  const fixture = state.bootstrap.demoFixtures.find(f => f.id === $('#demo-fixture').value);
  $('#demo-description').textContent = fixture?.description || '';
}
$('#demo-fixture').addEventListener('change', updateDemoDescription);
$('#demo-form').addEventListener('submit', async event => {
  event.preventDefault();
  await createRun({ mode: 'demo', fixture: $('#demo-fixture').value, reviewer: $('#demo-reviewer').value });
});
$('#new-run').addEventListener('click', showIntake);
$('#hero-new').addEventListener('click', showIntake);
$('#close-intake').addEventListener('click', closeIntake);
init().catch(error => toast(error.message));
