'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function ui() {
  const nodes = new Map();
  const node = selector => { if (!nodes.has(selector)) nodes.set(selector, { addEventListener() {}, checked: false }); return nodes.get(selector); };
  let selected = [];
  const context = vm.createContext({ document: { querySelector: node, querySelectorAll: selector => selector === '[data-proposal-id]:checked' ? selected : [] }, URL, setTimeout, clearTimeout });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8').replace(/init\(\)\.catch\(error => toast\(error.message\)\);\s*$/, ''), context);
  return { context, node, select: count => { selected = Array(count).fill({}); }, run: script => vm.runInContext(script, context) };
}
const proposal = { id: 'p1', name: 'Website', client: 'Serra', description: '<script>scope</script>', delivery_date: null, status: 'confirmed', deliverables: [{ text: 'Homepage', evidence: [{ line: 4, quote: 'Exact quotation <x>' }] }], requirements: [], evidence: [{ line: 3, quote: 'Website approved' }], date_evidence: [] };
test('brief cards keep exact content and evidence inside closed disclosures without nested item cards', () => {
  const app = ui(); app.context.proposal = proposal;
  const html = app.run('projectCard(proposal, false, new Set())');
  assert.match(html, /class="brief-list"/);
  assert.match(html, /<details class="source-detail"><summary>View source/);
  assert.match(html, /Exact quotation &lt;x&gt;/);
  assert.match(html, /Line 4/);
  assert.match(html, /&lt;script&gt;scope/);
  assert.doesNotMatch(html, /<details[^>]*\bopen\b|task-card|<h4>Requirements|\bchecked\b/);
  assert.match(html, /Delivery: <strong>Not agreed/);
});
test('approval button needs both explicit selection and evidence confirmation, and blocks blockers', () => {
  const app = ui();
  const button = app.node('[data-decision="Approve projects"]');
  app.run('updateApprovalSelection()'); assert.equal(button.disabled, true);
  app.select(2); app.run('updateApprovalSelection()'); assert.equal(button.disabled, true);
  app.node('#confirm-evidence').checked = true;
  app.run('updateApprovalSelection()'); assert.equal(button.disabled, false);
  assert.equal(app.node('#selection-count').textContent, '2 projects selected');
  app.run("state.current = {review:{blockers:['Conflict']}}; updateApprovalSelection()"); assert.equal(button.disabled, true);
});
test('final cards are read-only and review hides empty proposal groups', () => {
  const app = ui(); app.context.proposal = proposal;
  assert.doesNotMatch(app.run("projectCard(proposal, true, new Set(['p1']))"), /data-proposal-id/);
  app.context.record = { id: 'r1', title: 'Serra meeting', status: 'review', review: { kind: 'client_briefs', proposals: [proposal], lines: [], blockers: [], started_at: '2026-09-14T10:00:00Z' } };
  app.run('renderReview(record)');
  const html = app.node('#review').innerHTML;
  assert.match(html, /Confirmed proposals/);
  assert.doesNotMatch(html, /Needs your decision|No proposals in this section/);
  assert.match(html, /id="confirm-evidence"/);
  assert.match(html, /Full transcript &amp; review details/);
});
