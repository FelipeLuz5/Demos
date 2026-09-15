const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBrief, buildBriefReview, decideBrief } = require('../src/brief');
const { deliverNotion } = require('../src/notion-delivery');
function setup(duplicate = false) {
  const source = normalizeBrief({ title: 'Meeting', started_at: '2026-09-11T10:00:00Z', reviewer: 'Felipe', transcript: 'Website agreed.' });
  const evidence = [{ line: 1, quote: 'Website agreed.' }];
  const review = buildBriefReview(source, { proposals: [{ name: 'Website', client: null, description: 'Website', deliverables: [{ text: 'Website', evidence }], requirements: [], delivery_date: null, date_evidence: [], status: 'confirmed', evidence }] });
  if (duplicate) {
    review.proposals.push({ ...structuredClone(review.proposals[0]), id: 'second', description: 'Second scope' });
    review.digest = require('../src/brief').briefDigest(review);
  }
  const result = decideBrief(review, { decision: 'Approve projects', approvedProposalIds: review.proposals.map(p=>p.id), confirmEvidence: true });
  const record = { ...result, review };
  const ledger = new Map();
  return { record, store: { get: () => record, releaseNotion: k=>ledger.delete(k), notionDelivery: k => ledger.get(k), claimNotion: k => { if (ledger.has(k)) return false; ledger.set(k, { state: 'uncertain' }); return true; }, finishNotion: (k,p) => ledger.set(k, { state:'delivered',page_id:p.id,page_url:p.url }), saveDelivery: (id,d) => { record.artifact.delivery=d; return record; } } };
}
test('delivery sends approved projects only and repeated send reuses receipt', async () => {
  const { store } = setup(); let creates=0;
  const client = { validate: async()=>{}, find:async()=>null, create:async()=>{ creates++; return {id:'page',url:'https://www.notion.so/page'}; } };
  await deliverNotion(store,'run',client,{dataSourceId:'destination'});
  const r=await deliverNotion(store,'run',client,{dataSourceId:'destination'});
  assert.equal(creates,1); assert.equal(r.artifact.delivery.status,'delivered');
});
test('unknown outcome never blindly creates again, reconciliation can recover', async () => {
  const { store } = setup(); let creates=0; let found=null;
  const client = { validate:async()=>{},find:async()=>found,create:async()=>{creates++;throw new Error('timeout');} };
  assert.equal((await deliverNotion(store,'run',client,{dataSourceId:'destination'})).artifact.delivery.status,'uncertain');
  await deliverNotion(store,'run',client,{dataSourceId:'destination'});
  assert.equal(creates,1);
  found={id:'page',url:'https://www.notion.so/page'};
  assert.equal((await deliverNotion(store,'run',client,{dataSourceId:'destination'})).artifact.delivery.status,'delivered');
});
test('tampered approved project cannot be delivered', async () => {
  const { store,record }=setup(); record.artifact.projects[0].name='forged';
  await assert.rejects(deliverNotion(store,'run',{},{}),/integrity/);
});
test('automatic client routing refuses missing client names before any external calls', async () => {
  const {store}=setup();
  await assert.rejects(deliverNotion(store,'run',{}, {parentPageId:'root'}),/client name/);
});
test('same-name project scopes have separate delivery receipts', async () => {
  const {store}=setup(true);let creates=0;
  const client={validate:async()=>{},find:async()=>null,create:async()=>({id:String(++creates),url:'https://www.notion.so/page'})};
  const r=await deliverNotion(store,'run',client,{dataSourceId:'destination'});
  assert.equal(creates,2);assert.notEqual(r.artifact.delivery.pages[0].id,r.artifact.delivery.pages[1].id);
});
test('definitively rejected write can be retried safely', async () => {
  const {store}=setup();let creates=0;
  const client={validate:async()=>{},find:async()=>null,create:async()=>{ if(++creates===1){const e=new Error('HTTP 400');e.uncertain=false;throw e;}return {id:'page',url:'https://www.notion.so/page'};}};
  assert.equal((await deliverNotion(store,'run',client,{dataSourceId:'destination'})).artifact.delivery.status,'failed');
  assert.equal((await deliverNotion(store,'run',client,{dataSourceId:'destination'})).artifact.delivery.status,'delivered');
});
