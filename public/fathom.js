'use strict';

(() => {
  const panel = document.querySelector('#fathom-panel');
  const intake = document.querySelector('#intake');
  const form = document.querySelector('#manual-form');
  const connect = document.querySelector('#fathom-connect');
  const key = document.querySelector('#fathom-key');
  const status = document.querySelector('#fathom-status');
  const meetings = document.querySelector('#fathom-meetings');
  const selection = document.querySelector('#fathom-selection');
  const importButton = document.querySelector('#fathom-import');
  const more = document.querySelector('#fathom-more');
  let version = 0;
  let pending = false;
  let cursor = null;
  let checked = false;
  const lockedFields = new Map();
  const extracting = () => intake.classList.contains('loading');

  function message(text, error = false) {
    status.textContent = text;
    status.className = error ? 'notice blocker' : 'notice muted';
  }

  function sync() {
    const running = extracting();
    for (const field of form.querySelectorAll('input, textarea, select, button')) {
      if (running && !lockedFields.has(field)) {
        lockedFields.set(field, field.disabled);
        field.disabled = true;
      } else if (!running && lockedFields.has(field)) {
        field.disabled = lockedFields.get(field);
        lockedFields.delete(field);
      }
    }
    for (const field of panel.querySelectorAll('input, select, button')) field.disabled = running || pending;
    importButton.disabled = running || pending || !selection.value;
  }

  async function operation(work) {
    if (extracting() || pending) return;
    if (!state.csrf) { message('The app is still connecting. Try again shortly.'); return; }
    const current = ++version;
    pending = true;
    sync();
    const active = () => current === version && !extracting();
    try { await work(active); }
    catch (error) { if (active()) message(error.message, true); }
    finally { pending = false; sync(); }
  }

  async function list(active, nextCursor) {
    message('Loading Fathom meetings...');
    const result = await api('/api/fathom/meetings', { method: 'POST', body: JSON.stringify(nextCursor ? { cursor: nextCursor } : {}) });
    if (!active()) return;
    if (!nextCursor) selection.replaceChildren(new Option('Choose a meeting', ''));
    const existing = new Set(Array.from(selection.options, item => item.value));
    for (const item of result.meetings || []) {
      if (existing.has(String(item.id))) continue;
      selection.add(new Option(`${item.title || 'Untitled meeting'}${item.started_at ? ` - ${item.started_at}` : ''}`, String(item.id)));
      existing.add(String(item.id));
    }
    cursor = result.nextCursor || null;
    more.classList.toggle('hidden', !cursor);
    message(selection.options.length > 1 ? 'Choose a meeting to import its transcript.' : 'No meetings available yet. Record a meeting in Fathom, then refresh.');
  }

  panel.addEventListener('toggle', () => {
    if (!panel.open || checked) return;
    operation(async active => {
      const result = await api('/api/fathom/status');
      if (!active()) return;
      checked = true;
      connect.classList.toggle('hidden', result.configured);
      meetings.classList.toggle('hidden', !result.configured);
      message(result.configured ? 'Fathom connected. Refresh meetings to get started.' : 'Add your Fathom API key to connect.');
    });
  });

  connect.addEventListener('submit', event => {
    event.preventDefault();
    const apiKey = key.value.trim();
    key.value = '';
    if (!apiKey) return;
    operation(async active => {
      message('Connecting Fathom...');
      await api('/api/fathom/connect', { method: 'POST', body: JSON.stringify({ apiKey }) });
      if (!active()) return;
      connect.classList.add('hidden');
      meetings.classList.remove('hidden');
      checked = true;
      await list(active);
    });
  });
  document.querySelector('#fathom-refresh').addEventListener('click', () => operation(active => list(active)));
  more.addEventListener('click', () => operation(active => list(active, cursor)));
  document.querySelector('#fathom-reconnect').addEventListener('click', () => { if (pending || extracting()) return; version++; connect.classList.remove('hidden'); key.focus(); });
  selection.addEventListener('change', () => { version++; sync(); });
  importButton.addEventListener('click', () => {
    const id = selection.value;
    if (!id) return;
    operation(async active => {
      ++importVersion;
      message('Importing transcript...');
      const result = await api('/api/fathom/import', { method: 'POST', body: JSON.stringify({ id }) });
      if (!active()) return;
      if (!result.transcript || result.transcript.length > 40000) throw new Error('This transcript is empty or exceeds the 40,000 character review limit.');
      ++importVersion;
      FdeConsent.clear(form);
      for (const name of ['title', 'started_at', 'transcript']) form.elements.namedItem(name).value = result[name] || '';
      form.elements.namedItem('client').value = '';
      document.querySelector('#transcript-file').value = '';
      document.querySelector('#import-status').classList.add('hidden');
      message('Transcript imported. Check the meeting details below, then approve extraction.');
    });
  });
  form.addEventListener('input', () => { version++; });
  form.addEventListener('change', () => { version++; });
  form.addEventListener('submit', event => {
    if (extracting()) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    version++;
    ++importVersion;
  }, true);
  for (const id of ['new-run', 'hero-new', 'close-intake']) document.getElementById(id).addEventListener('click', () => { version++; });
  new MutationObserver(sync).observe(intake, { attributes: true, attributeFilter: ['class'] });
})();
