// Threshold — Stripe billing
// Free to integrate — Stripe only takes a % once a customer actually pays.
// Add this to server.js. Requires STRIPE_SECRET_KEY and price IDs in .env.

const Stripe = require("stripe");
const express = require("express");

function registerBillingRoutes(app, supabase) {
  const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

  const PRICE_IDS = {
    starter: process.env.STRIPE_PRICE_STARTER,
    pro: process.env.STRIPE_PRICE_PRO,
    scale: process.env.STRIPE_PRICE_SCALE,
    site_builder: process.env.STRIPE_PRICE_SITE_BUILDER, // add-on, one-time or recurring — your call
  };

  /* -----------------------------------------------------------
     POST /api/billing/checkout
     Body: { orgId, tier } or { orgId, addon: "site_builder" }
     Creates a Stripe Checkout session and returns the URL to redirect to.
  ----------------------------------------------------------- */
  app.post("/api/billing/checkout", express.json(), async (req, res) => {
    const { orgId, tier, addon } = req.body || {};
    if (!orgId || (!tier && !addon)) {
      return res.status(400).json({ error: "orgId and either tier or addon are required" });
    }

    const priceId = addon ? PRICE_IDS[addon] : PRICE_IDS[tier];
    if (!priceId) return res.status(400).json({ error: "Unknown tier or addon" });

    try {
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("stripe_customer_id")
        .eq("org_id", orgId)
        .single();

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: sub && sub.stripe_customer_id ? sub.stripe_customer_id : undefined,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${process.env.FRONTEND_URL}/?billing=success`,
        cancel_url: `${process.env.FRONTEND_URL}/?billing=canceled`,
        metadata: { orgId, tier: tier || "", addon: addon || "" },
      });

      res.json({ url: session.url });
    } catch (err) {
      console.error("Stripe checkout error:", err);
      res.status(500).json({ error: "Could not create checkout session" });
    }
  });

  /* -----------------------------------------------------------
     POST /api/webhooks/stripe
     Stripe calls this when checkout completes, subscription updates,
     or payment fails. Set this URL in your Stripe dashboard webhooks.
     IMPORTANT: this route needs the raw body, not JSON-parsed —
     see the note in server.js about where to mount it.
  ----------------------------------------------------------- */
  app.post("/api/webhooks/stripe", express.raw({ type: "application/json" }), async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("Stripe webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orgId = session.metadata.orgId;
      const tier = session.metadata.tier;
      const addon = session.metadata.addon;

      if (addon === "site_builder") {
        await supabase.from("subscriptions").update({ site_builder_unlocked: true }).eq("org_id", orgId);
      } else if (tier) {
        const minutesByTier = { starter: 500, pro: 2000, scale: 8000 };
        await supabase.from("subscriptions").update({
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          tier,
          minutes_included: minutesByTier[tier] || 500,
          status: "active",
        }).eq("org_id", orgId);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      await supabase.from("subscriptions").update({ status: "canceled" }).eq("stripe_subscription_id", sub.id);
    }

    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      await supabase.from("subscriptions").update({ status: "past_due" }).eq("stripe_subscription_id", invoice.subscription);
    }

    res.json({ received: true });
  });
}

module.exports = { registerBillingRoutes };

/* Requires "stripe" in package.json:
   npm install stripe
*/
