// Records every new Khazna deposit on Shopify as a manual (partial) payment,
// so the order's outstanding amount = the COD that Bosta should collect.
// Reads/writes khazna-data/data.json with DATA_TOKEN; marks each deposit with
// shopAt (recorded) or shopErr (skipped + reason) so it never runs twice.
const SHOP = process.env.SHOPIFY_SHOP || 'qb1edf-5a.myshopify.com';
const OWNER = 'bavelly', DATA_REPO = 'khazna-data', FILE = 'data.json';
const GH = `https://api.github.com/repos/${OWNER}/${DATA_REPO}/contents/${FILE}`;
const DATA_TOKEN = process.env.DATA_TOKEN;
if (!DATA_TOKEN) throw new Error('DATA_TOKEN secret is missing (GitHub token with Contents read/write on khazna-data)');
const TAG = 'khazna-deposit';
const RETRY_DAYS = 3; // order number not on Shopify yet -> keep trying this long

const ghHead = { Authorization: 'Bearer ' + DATA_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function loadData() {
  const r = await fetch(GH + '?t=' + Date.now(), { headers: ghHead });
  if (!r.ok) throw new Error('Cannot read data.json: ' + r.status);
  const j = await r.json();
  return { sha: j.sha, state: JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')) };
}
async function saveMarks(marks) {
  for (let i = 0; i < 5; i++) {
    const { sha, state } = await loadData();
    for (const d of state.deposits || []) if (marks[d.id]) Object.assign(d, marks[d.id]);
    const r = await fetch(GH, { method: 'PUT', headers: ghHead, body: JSON.stringify({
      message: 'Shopify deposits: ' + Object.keys(marks).length, sha,
      content: Buffer.from(JSON.stringify(state, null, 1)).toString('base64') }) });
    if (r.ok) return;
    if (r.status !== 409 && r.status !== 422) throw new Error('Cannot save data.json: ' + r.status);
    await new Promise(res => setTimeout(res, 1500));
  }
  throw new Error('Could not save data.json after retries');
}

async function getToken() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.SHOPIFY_CLIENT_ID || '', client_secret: process.env.SHOPIFY_CLIENT_SECRET || '' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Shopify token request failed: ' + r.status);
  return j.access_token;
}
let token;
async function shop(query, variables) {
  const r = await fetch(`https://${SHOP}/admin/api/2026-04/graphql.json`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors) throw new Error('Shopify: ' + JSON.stringify(j.errors).slice(0, 300));
  return j.data;
}
const FIND = `query($q:String){ orders(first:5, query:$q){ nodes{ id name cancelledAt tags displayFinancialStatus displayFulfillmentStatus
  currentTotalPriceSet{shopMoney{amount}} totalOutstandingSet{shopMoney{amount}} } } }`;
const PAY = `mutation($id:ID!,$amount:MoneyInput!,$at:DateTime){ orderCreateManualPayment(id:$id, amount:$amount, paymentMethodName:"Deposit (Khazna)", processedAt:$at){
  order{ displayFinancialStatus totalOutstandingSet{shopMoney{amount}} } userErrors{ field message } } }`;
const TAGS = `mutation($id:ID!,$tags:[String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ message } } }`;

const { state } = await loadData();
const todo = (state.deposits || []).filter(d => !d.done && !d.shopAt && !d.shopErr);
if (!todo.length) { console.log('No new deposits'); process.exit(0); }
token = await getToken();
const marks = {};
const now = Date.now();
for (const d of todo) {
  const amt = Math.round((Number(d.amount) || 0) * 100) / 100;
  const skip = why => { marks[d.id] = { shopErr: why, shopErrAt: now }; console.log(`#${d.order}: skipped — ${why}`); };
  try {
    const nodes = (await shop(FIND, { q: `name:#${d.order}` })).orders.nodes;
    const o = nodes.find(x => x.name.replace('#', '') === String(d.order));
    if (!o) {
      if (now - (Number(d.at) || now) > RETRY_DAYS * 864e5) skip('Order not found on Shopify');
      else console.log(`#${d.order}: not on Shopify yet, will retry`);
      continue;
    }
    const total = Number(o.currentTotalPriceSet.shopMoney.amount), due = Number(o.totalOutstandingSet.shopMoney.amount);
    if (o.tags.includes(TAG)) { marks[d.id] = { shopAt: now, shopNote: 'already recorded' }; continue; }
    if (o.cancelledAt) { skip('Order is cancelled'); continue; }
    if (o.displayFulfillmentStatus !== 'UNFULFILLED') { skip('Order already fulfilled / shipped'); continue; }
    if (due < total - 0.01) { skip(`Order already has a payment on Shopify (unpaid ${due} of ${total})`); continue; }
    if (amt <= 0 || amt > due + 0.01) { skip(`Deposit ${amt} is more than the unpaid amount ${due}`); continue; }
    const res = (await shop(PAY, { id: o.id, amount: { amount: String(amt), currencyCode: 'EGP' }, at: new Date(Number(d.at) || now).toISOString() })).orderCreateManualPayment;
    if (res.userErrors.length) { skip('Shopify: ' + res.userErrors.map(e => e.message).join('; ')); continue; }
    await shop(TAGS, { id: o.id, tags: [TAG] }).catch(() => {});
    const left = Number(res.order.totalOutstandingSet.shopMoney.amount);
    marks[d.id] = { shopAt: now, shopDue: left };
    console.log(`#${d.order}: deposit ${amt} recorded, COD now ${left}`);
  } catch (e) {
    console.log(`#${d.order}: error, will retry — ${e.message}`);
    if (/access|scope|denied/i.test(e.message)) { if (Object.keys(marks).length) await saveMarks(marks); throw new Error('Shopify app has no permission to record payments — give it write_orders. ' + e.message); }
  }
}
if (Object.keys(marks).length) await saveMarks(marks);
console.log('Done');
