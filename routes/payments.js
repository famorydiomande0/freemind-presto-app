const express = require("express");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const router = express.Router();
const COMMISSION_RATE = Number(process.env.PLATFORM_COMMISSION_RATE || 0.2);

// POST /api/payments/create-intent
// Called right after booking creation. Uses Stripe Connect "destination
// charges": the client pays the platform, Stripe automatically routes the
// provider's share to their connected account, platform keeps the rest.
router.post("/create-intent", requireAuth, async (req, res) => {
  const { bookingId } = req.body;

  const { rows } = await pool.query(
    `SELECT b.total_price_cents, b.currency, pp.stripe_account_id
     FROM bookings b
     JOIN provider_profiles pp ON pp.user_id = b.provider_id
     WHERE b.id = $1 AND b.client_id = $2`,
    [bookingId, req.user.id]
  );
  const booking = rows[0];
  if (!booking) return res.status(404).json({ error: "booking_not_found" });

  const providerShare = Math.round(booking.total_price_cents * (1 - COMMISSION_RATE));

  const paymentIntent = await stripe.paymentIntents.create({
    amount: booking.total_price_cents,
    currency: booking.currency.toLowerCase(),
    automatic_payment_methods: { enabled: true },
    transfer_data: {
      destination: booking.stripe_account_id,
      amount: providerShare, // platform keeps total - providerShare as commission
    },
    metadata: { booking_id: bookingId },
  });

  await pool.query(`UPDATE bookings SET stripe_payment_intent_id = $1 WHERE id = $2`, [paymentIntent.id, bookingId]);

  res.json({ clientSecret: paymentIntent.client_secret });
});

// Stripe webhook — mounted with express.raw() in server.js (signature
// verification requires the raw request body, not JSON-parsed).
router.post("/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  switch (event.type) {
    case "payment_intent.succeeded": {
      const bookingId = event.data.object.metadata.booking_id;
      await pool.query(`UPDATE bookings SET status = 'confirmed', updated_at = now() WHERE id = $1`, [bookingId]);
      break;
    }
    case "account.updated": {
      const account = event.data.object;
      await pool.query(
        `UPDATE provider_profiles SET stripe_account_ready = $1 WHERE stripe_account_id = $2`,
        [!!account.payouts_enabled, account.id]
      );
      break;
    }
    case "identity.verification_session.verified": {
      const userId = event.data.object.metadata.user_id;
      await pool.query(`UPDATE provider_profiles SET identity_status = 'verified' WHERE user_id = $1`, [userId]);
      break;
    }
    case "identity.verification_session.requires_input": {
      const userId = event.data.object.metadata.user_id;
      await pool.query(`UPDATE provider_profiles SET identity_status = 'rejected' WHERE user_id = $1`, [userId]);
      break;
    }
    default:
      break; // ignore other event types
  }

  res.json({ received: true });
});

module.exports = router;
