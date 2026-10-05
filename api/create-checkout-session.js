// BEMVINHOS — Stripe Checkout Session (Vercel serverless function)
// Route: POST /api/create-checkout-session
// Deploy this file at: <project>/api/create-checkout-session.js on Vercel.
//
// Required environment variables (Vercel → Settings → Environment Variables):
//   STRIPE_SECRET_KEY   sk_live_... (or sk_test_... while testing)
//   SITE_URL            https://bemvinhos.com   (return page after paying)
//
// After each payment Stripe creates a PDF INVOICE and emails it to the customer
// (wines, cases, pickup branch, fee breakdown). Turn on emails in:
//   Stripe Dashboard → Settings → Customer emails → "Successful payments"

const Stripe = require('stripe');

// --- Fee model (must match the website) --------------------------------------
//   online = agencyBase × (1 + 3% Stripe + 5% TPS + 9,975% TVQ)
const TXN_RATE = 0.03;
const TPS_RATE = 0.05;
const TVQ_RATE = 0.09975;
const TAX_TXN_MULTIPLIER = 1 + TXN_RATE + TPS_RATE + TVQ_RATE; // 1.17975
// Safety clamp on the per-case fee we accept (cents): $10–$80 per case.
const FEE_MIN_CENTS = 1000;
const FEE_MAX_CENTS = 8000;

// Promo codes — MUST match the website (BEMVINHOS.dc.html → PROMO_CODES).
// Discount is applied to the agency fee base, before taxes.
const PROMO_CODES = {
  DEGUSTATION: { pct: 15 },
  MERCI10: { pct: 10 },
  AMI25: { pct: 25 },
  'VIP75@BEM': { pct: 75 },
  'VIP50@VINHOS': { pct: 50 },
  'AIRBUS50@BEM': { pct: 50 },
};

// Used when the customer doesn't choose a pickup branch.
const DEFAULT_BRANCH = 'Centre de distribution SAQ — 1947 Rue des Futailles, Montréal, QC H1N 3P1';
// -----------------------------------------------------------------------------

const money = (cents) => (cents / 100).toFixed(2).replace('.', ',') + ' $';
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return res.status(400).json({ error: 'empty_cart' });

    // Re-total the agency fee from each item (cases × per-case fee, clamped).
    let agencyBaseCents = 0;
    let totalCases = 0;
    let bottles = 0;
    const lines = [];
    for (const it of items) {
      const cases = Math.max(0, Math.round(Number(it.cases) || 0));
      if (!cases) continue;
      const box = Number(it.boxSize) === 3 ? 3 : 6;
      let fee = Math.round(Number(it.feeCents) || 0);
      if (fee < FEE_MIN_CENTS) fee = FEE_MIN_CENTS;
      if (fee > FEE_MAX_CENTS) fee = FEE_MAX_CENTS;
      agencyBaseCents += fee * cases;
      totalCases += cases;
      bottles += cases * box;
      lines.push({ name: String(it.name || ''), cases, box, feeCents: fee });
    }
    if (totalCases < 1 || agencyBaseCents <= 0) {
      return res.status(400).json({ error: 'invalid_cart' });
    }

    // Promo code on the agency fee base (before taxes).
    let discountCents = 0;
    let promoApplied = '';
    const promo = PROMO_CODES[String(body.promoCode || '').trim().toUpperCase()];
    if (promo) {
      promoApplied = String(body.promoCode).trim().toUpperCase();
      discountCents = promo.pct
        ? Math.round(agencyBaseCents * (promo.pct / 100))
        : Math.min(Math.round((promo.amount || 0) * 100), agencyBaseCents);
    }
    const netBaseCents = Math.max(0, agencyBaseCents - discountCents);
    const amountCents = Math.round(netBaseCents * TAX_TXN_MULTIPLIER);

    // Breakdown for the invoice (txn/TPS rounded, TVQ absorbs the last cent).
    const txnCents = Math.round(netBaseCents * TXN_RATE);
    const tpsCents = Math.round(netBaseCents * TPS_RATE);
    const tvqCents = amountCents - netBaseCents - txnCents - tpsCents;

    const branch = body.branch && body.branch.address
      ? `SAQ ${body.branch.city} — ${body.branch.address}${body.branch.num && body.branch.num !== 'CD' ? ' (#' + body.branch.num + ')' : ''}`
      : DEFAULT_BRANCH;

    const itemsSummary = lines.map((l) => `${l.cases}×${l.box} ${l.name}`).join(' · ');

    // Invoice footer: full order detail (shown on the PDF + email).
    const footer = [
      'DÉTAIL DE LA COMMANDE',
      ...lines.map((l) => `• ${l.name} — ${l.cases} caisse(s) de ${l.box} (${l.cases * l.box} bt) · frais ${money(l.feeCents)}/caisse = ${money(l.feeCents * l.cases)}`),
      '',
      `Frais d'agence : ${money(agencyBaseCents)}`,
      ...(discountCents ? [`Rabais (${promoApplied}) : – ${money(discountCents)}`] : []),
      `Frais de transaction (3 %) : ${money(txnCents)}`,
      `TPS (5 %) : ${money(tpsCents)}`,
      `TVQ (9,975 %) : ${money(tvqCents)}`,
      `Total payé (Facture 1) : ${money(amountCents)}`,
      '',
      `Succursale de cueillette : ${branch}`,
      '',
      "Facture 2 — Le prix du vin est payé directement à la SAQ lors de la cueillette.",
      'Nous vous écrirons dès que votre commande est prête. Merci ! — BEMVINHOS · asantos@bemvinhos.com',
    ].join('\n');

    const SITE = process.env.SITE_URL || 'https://bemvinhos.com';

    const orderMeta = {
      cases: String(totalCases),
      bottles: String(bottles),
      agency_base: (agencyBaseCents / 100).toFixed(2),
      promo_code: promoApplied,
      discount: (discountCents / 100).toFixed(2),
      total: (amountCents / 100).toFixed(2),
      pickup_branch: cut(branch, 480),
      items: cut(itemsSummary, 480),
    };

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'cad',
          unit_amount: amountCents,
          product_data: {
            name: "BEMVINHOS — Frais d'agence (Facture 1)",
            description: cut(`${totalCases} caisse(s) · ${bottles} bouteilles · ${itemsSummary} · frais et taxes inclus`, 480),
          },
        },
      }],
      customer_creation: 'always',
      metadata: orderMeta,
      payment_intent_data: {
        description: cut(`BEMVINHOS — ${itemsSummary} → ${branch}`, 900),
        metadata: orderMeta,
      },
      // Creates a PDF invoice after payment, emailed to the customer.
      invoice_creation: {
        enabled: true,
        invoice_data: {
          description: cut(`Commande BEMVINHOS — ${totalCases} caisse(s), ${bottles} bouteilles`, 480),
          metadata: orderMeta,
          custom_fields: [
            { name: 'Cueillette', value: cut(branch, 140) },
            { name: 'Bouteilles', value: `${bottles} (${totalCases} caisse${totalCases > 1 ? 's' : ''})` },
            ...(promoApplied ? [{ name: 'Code promo', value: promoApplied }] : []),
          ],
          footer: cut(footer, 4900),
        },
      },
      success_url: `${SITE}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE}/?canceled=1#commander`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'stripe_error' });
  }
};
