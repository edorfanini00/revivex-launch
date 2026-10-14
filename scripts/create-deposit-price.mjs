// Find or create the one-time $50 USD deposit price (deposit-terms-v3) on the existing
// deposit product, then read it back. Prices are immutable, so this never edits one.
// A rerun finds the price by lookup key; a retried create reuses the same Idempotency-Key.
//
//   STRIPE_SECRET_KEY=… STRIPE_MODE=test|live STRIPE_EXPECTED_ACCOUNT_ID=acct_… \
//   STRIPE_DEPOSIT_PRODUCT_ID=prod_… node scripts/create-deposit-price.mjs [--check]
//
// --check only looks the price up and verifies it; it never creates.
// Prints the price id and checks only; never the key.
import { DEPOSIT, STRIPE_API_VERSION } from '../lib/deposit-config.js';

export const LOOKUP_KEY = `revivex_deposit_${DEPOSIT.currency}_${DEPOSIT.amount}_v3`;
export const PRICE_METADATA = Object.freeze({
  purpose: DEPOSIT.purpose,
  terms_version: DEPOSIT.termsVersion,
  machine_discount_percent: String(DEPOSIT.machineDiscountPercent),
});

export function priceParams(productId) {
  return {
    product: productId,
    currency: DEPOSIT.currency,
    unit_amount: String(DEPOSIT.amount),
    lookup_key: LOOKUP_KEY,
    nickname: `Revivex preorder deposit $${DEPOSIT.amount / 100} (${DEPOSIT.termsVersion})`,
    'metadata[purpose]': PRICE_METADATA.purpose,
    'metadata[terms_version]': PRICE_METADATA.terms_version,
    'metadata[machine_discount_percent]': PRICE_METADATA.machine_discount_percent,
  };
}

export function priceIssues(p, { productId, live }) {
  const issues = [];
  const productOf = typeof p?.product === 'string' ? p.product : p?.product?.id;
  if (p?.object !== 'price') issues.push('object');
  if (p?.active !== true) issues.push('active');
  if (p?.livemode !== live) issues.push('livemode');
  if (p?.type !== 'one_time' || p?.recurring) issues.push('type');
  if (p?.billing_scheme !== 'per_unit' || p?.custom_unit_amount || p?.transform_quantity || p?.tiers_mode) issues.push('billing');
  if (p?.currency !== DEPOSIT.currency) issues.push('currency');
  if (p?.unit_amount !== DEPOSIT.amount) issues.push('unit_amount');
  if (p?.currency_options && Object.keys(p.currency_options).some(c => c !== DEPOSIT.currency)) issues.push('currency_options');
  if (productOf !== productId) issues.push('product');
  if (p?.lookup_key !== LOOKUP_KEY) issues.push('lookup_key');
  for (const [k, v] of Object.entries(PRICE_METADATA)) if (p?.metadata?.[k] !== v) issues.push(`metadata.${k}`);
  return issues;
}

async function stripe(key, method, path, form, idempotencyKey) {
  const headers = { Authorization: `Bearer ${key}`, 'Stripe-Version': STRIPE_API_VERSION };
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const r = await fetch(`https://api.stripe.com${path}`, { method, headers, body: form ? new URLSearchParams(form).toString() : undefined, redirect: 'error' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`stripe ${method} ${path.split('?')[0]} ${r.status} ${body?.error?.type || ''} ${body?.error?.code || ''}`.trim());
  return body;
}

async function main() {
  const { STRIPE_SECRET_KEY: key = '', STRIPE_MODE: mode = '', STRIPE_EXPECTED_ACCOUNT_ID: accountId = '', STRIPE_DEPOSIT_PRODUCT_ID: productId = '' } = process.env;
  const checkOnly = process.argv.includes('--check');
  if (!['test', 'live'].includes(mode)) throw new Error('STRIPE_MODE must be test or live');
  if (!new RegExp(`^(sk|rk)_${mode}_`).test(key)) throw new Error('STRIPE_SECRET_KEY does not match STRIPE_MODE');
  if (!/^acct_[A-Za-z0-9]{6,64}$/.test(accountId) || !/^prod_[A-Za-z0-9]{6,64}$/.test(productId)) throw new Error('STRIPE_EXPECTED_ACCOUNT_ID / STRIPE_DEPOSIT_PRODUCT_ID missing or malformed');
  const live = mode === 'live';

  const account = await stripe(key, 'GET', '/v1/account');
  if (account.id !== accountId) throw new Error('account does not match STRIPE_EXPECTED_ACCOUNT_ID');
  const product = await stripe(key, 'GET', `/v1/products/${productId}`);
  if (product.active !== true || product.livemode !== live) throw new Error('product inactive or in the wrong mode');

  const found = await stripe(key, 'GET', `/v1/prices?lookup_keys[]=${LOOKUP_KEY}&limit=10`);
  let price = found.data?.[0];
  let created = false;
  if ((found.data || []).length > 1) throw new Error('more than one price has the lookup key');
  if (!price) {
    if (checkOnly) throw new Error('no price with the lookup key (run without --check to create it)');
    price = await stripe(key, 'POST', '/v1/prices', priceParams(productId), `rvx-deposit-price-${LOOKUP_KEY}-${productId}`);
    created = true;
  }
  const readBack = await stripe(key, 'GET', `/v1/prices/${price.id}`);
  const issues = priceIssues(readBack, { productId, live });
  console.log(JSON.stringify({ mode, account_matches: true, product_active: true, created, price_id: readBack.id, unit_amount: readBack.unit_amount, currency: readBack.currency, type: readBack.type, livemode: readBack.livemode, lookup_key: readBack.lookup_key, metadata: readBack.metadata, issues }, null, 1));
  if (issues.length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(String(e.message || e)); process.exitCode = 1; });
