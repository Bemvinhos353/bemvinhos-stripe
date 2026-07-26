// BEMVINHOS — Stripe Checkout Session (Vercel serverless function)
// Route: POST /api/create-checkout-session
// Deploy this file at: <project>/api/create-checkout-session.js on Vercel.
//
// Required environment variables (Vercel → Settings → Environment Variables):
//   STRIPE_SECRET_KEY   sk_live_... (or sk_test_... while testing)
//   SITE_URL            https://bemvinhos.com   (return page after paying)

const Stripe = require('stripe');

// --- Fee model (must match the website) --------------------------------------
// The agency fee VARIES per wine (the "Agency fee per case" column in the wine
// sheet). The site sends each cart item with its per-case fee in cents; here we
// re-total it and add the same taxes, so the Stripe charge equals the panier.
//   online = agencyBase × (1 + 3% Stripe + 5% TPS + 9,975% TVQ)
const TAX_TXN_MULTIPLIER = 1.17975;
// Safety clamp on the per-case fee we accept (cents): $10–$80 per case.
const FEE_MIN_CENTS = 1000;
const FEE_MAX_CENTS = 8000;

// Promo codes — MUST match the website (BEMVINHOS.dc.html → PROMO_CODES).
// Discount is applied to the agency fee base, before taxes.
const PROMO_CODES = {
  DEGUSTATION: { pct: 15 },
  MERCI10: { pct: 10 },
  AMI25: { pct: 25 },
};
// -----------------------------------------------------------------------------

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
    for (const it of items) {
      const cases = Math.max(0, Math.round(Number(it.cases) || 0));
      let fee = Math.round(Number(it.feeCents) || 0);
      if (fee < FEE_MIN_CENTS) fee = FEE_MIN_CENTS;
      if (fee > FEE_MAX_CENTS) fee = FEE_MAX_CENTS;
      agencyBaseCents += fee * cases;
      totalCases += cases;
    }
    if (totalCases < 1 || agencyBaseCents <= 0) {
      return res.status(400).json({ error: 'invalid_cart' });
    }

    // Apply promo code to the agency fee base (before taxes), if valid.
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
    const bottles = totalCases * 6;

    const branch = body.branch
      ? `${body.branch.address}, ${body.branch.city} (#${body.branch.num})`
      : 'À préciser';
    const itemsSummary = items
      .map((it) => `${it.cases}×6 ${it.name}`)
      .join(' · ')
      .slice(0, 480);

    const SITE = process.env.SITE_URL || 'https://bemvinhos.com';

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
            description: `${totalCases} caisse(s) de 6 · ${bottles} bouteilles · frais et taxes inclus`,
          },
        },
      }],
      customer_creation: 'always',
      metadata: {
        cases: String(totalCases),
        bottles: String(bottles),
        agency_base: (agencyBaseCents / 100).toFixed(2),
        promo_code: promoApplied,
        discount: (discountCents / 100).toFixed(2),
        total: (amountCents / 100).toFixed(2),
        pickup_branch: branch,
        items: itemsSummary,
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
