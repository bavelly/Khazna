// Builds the moderator orders feed: Shopify orders from START_DATE onward,
// encrypted with MOD_PASSWORD so the public site only serves ciphertext.
import fs from 'node:fs';
import crypto from 'node:crypto';

const SHOP = process.env.SHOPIFY_SHOP || 'qb1edf-5a.myshopify.com';
const START = process.env.START_DATE || '2026-11-16T00:00:00+02:00';
const PASS = process.env.MOD_PASSWORD;
if (!PASS) throw new Error('MOD_PASSWORD secret is missing');

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
const Q = `query($q:String,$after:String){ orders(first:100, after:$after, query:$q, sortKey:CREATED_AT, reverse:true){
  pageInfo{hasNextPage endCursor}
  nodes{ name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
    totalPriceSet{shopMoney{amount}} totalOutstandingSet{shopMoney{amount}}
    shippingAddress{name address1 address2 city province phone} phone email note
    lineItems(first:50){ nodes{ title variantTitle quantity customAttributes{key value} } } } } }`;
function details(attrs) {
  const names = {}, colours = {}, other = [];
  for (const { key, value } of (attrs || []).filter(x => !x.key.startsWith('_'))) {
    let m;
    if ((m = key.match(/^Name (\d+) colou?r$/i))) colours[m[1]] = value.trim();
    else if ((m = key.match(/^Name (\d+)$/i))) names[m[1]] = value.trim();
    else if (/^(one name|2 names|multiple names)\.?$/i.test(key)) other.push(value.trim());
    else other.push(`${key}: ${value}`.trim());
  }
  return [...Object.keys(names).sort((a, b) => a - b).map(n => `Name ${n}: ${names[n]}${colours[n] ? ` (${colours[n]})` : ''}`), ...other].join(' · ');
}
const token = await getToken();
const orders = [];
let after = null;
do {
  const r = await fetch(`https://${SHOP}/admin/api/2026-04/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token }, body: JSON.stringify({ query: Q, variables: { q: `created_at:>='${START}'`, after } }) });
  const j = await r.json();
  if (j.errors) throw new Error('Shopify query failed');
  for (const o of j.data.orders.nodes) {
    const s = o.shippingAddress || {};
    orders.push({
      n: o.name.replace('#', ''), at: o.createdAt, name: s.name || '', phone: s.phone || o.phone || '',
      address: [s.address1, s.address2].filter(Boolean).join(', '), city: [...new Set([s.city, s.province].filter(Boolean))].join(', '),
      total: Number(o.totalPriceSet.shopMoney.amount), due: Number(o.totalOutstandingSet.shopMoney.amount),
      payment: o.displayFinancialStatus, fulfillment: o.displayFulfillmentStatus, cancelled: !!o.cancelledAt, note: o.note || '',
      items: o.lineItems.nodes.map(li => ({ t: li.title, v: li.variantTitle || '', q: li.quantity, d: details(li.customAttributes) })),
    });
  }
  after = j.data.orders.pageInfo.hasNextPage ? j.data.orders.pageInfo.endCursor : null;
} while (after);

// skip rewrite when nothing changed (avoids a commit every run)
try {
  const old = JSON.parse(fs.readFileSync('mod/orders.enc.json', 'utf8'));
  const k = crypto.pbkdf2Sync(PASS, Buffer.from(old.salt, 'base64'), old.iter, 32, 'sha256');
  const buf = Buffer.from(old.data, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(old.iv, 'base64'));
  d.setAuthTag(buf.subarray(buf.length - 16));
  const prev = JSON.parse(Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]).toString());
  if (JSON.stringify(prev.orders) === JSON.stringify(orders)) { console.log('No changes'); process.exit(0); }
} catch (_) {}
const plain = Buffer.from(JSON.stringify({ syncedAt: new Date().toISOString(), orders }));
const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(PASS, salt, 250000, 32, 'sha256');
const c = crypto.createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
fs.writeFileSync('mod/orders.enc.json', JSON.stringify({ v: 1, iter: 250000, salt: salt.toString('base64'), iv: iv.toString('base64'), data: enc.toString('base64') }));
console.log(`Moderator feed updated: ${orders.length} orders`);
