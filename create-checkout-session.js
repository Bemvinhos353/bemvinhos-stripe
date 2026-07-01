// BEMVINHOS — Stripe Checkout Session (Vercel serverless function)
// Route: POST /api/create-checkout-session
// Deploy this file at: <project>/api/create-checkout-session.js on Vercel.
//
// Required environment variables (set in Vercel → Project → Settings → Environment Variables):
//   STRIPE_SECRET_KEY   sk_live_... (or sk_test_... while testing)
//   SITE_URL            https://bemvinhos.com   (where customers return after paying)

const Stripe = require('stripe');

// --- Fee model (must match the website EXACTLY) -----------------------------
// The site bills a flat, penny-exact PER CASE OF 6 amount and multiplies by the
// number of cases. We do the same here so the Stripe total always equals the
// panier total to the cent.
//   21,00 $ agency (6 × 3,50 $) + 0,63 $ txn (3%) + 1,05 $ TPS + 2,09 $ TVQ
const PER_CASE_TOTAL_CENTS = 2477; // 24,77 $  → keep in sync with the website
// ----------------------------------------------------------------------------

module.exports = async (req, res) => {
  // CORS (safe to keep even if same-origin)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

    // Trust ONLY the bottle count from the client; recompute the amount here.
    const bottles = Math.round(Number(body.bottles) || 0);
    if (!bottles || bottles < 6 || bottles % 6 !== 0) {
      return res.status(400).json({ error: 'invalid_bottles' });
    }

    const cases = bottles / 6;
    const amountCents = PER_CASE_TOTAL_CENTS * cases;   // penny-exact, matches site

    const branch = body.branch
      ? `${body.branch.address}, ${body.branch.city} (#${body.branch.num})`
      : 'À préciser';
    const itemsSummary = Array.isArray(body.items)
      ? body.items.map((it) => `${it.cases}×6 ${it.name}`).join(' · ').slice(0, 480)
      : '';

    const SITE = process.env.SITE_URL || '';

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
            description: `${cases} caisse(s) de 6 · ${bottles} bouteilles · frais et taxes inclus`,
          },
        },
      }],
      // Collect the buyer's email on Stripe's hosted page
      customer_creation: 'always',
      metadata: {
        cases: String(cases),
        bottles: String(bottles),
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
