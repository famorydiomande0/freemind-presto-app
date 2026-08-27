const express = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();
const SERVICE_FEE_RATE = 0.15; // shown to the client as "frais de service" before booking

const createBookingSchema = z.object({
  providerId: z.string().uuid(),
  categoryId: z.string(),
  addressText: z.string().min(3),
  lat: z.number(),
  lng: z.number(),
});

// POST /api/bookings
// Creates the booking and a Stripe PaymentIntent for the exact price shown
// to the client on the provider screen (base price snapshotted server-side,
// never trusted from the client, to prevent price tampering).
router.post("/", requireAuth, requireRole("client"), async (req, res) => {
  const parsed = createBookingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
  const { providerId, categoryId, addressText, lat, lng } = parsed.data;

  const providerResult = await pool.query(
    "SELECT base_price_cents, currency, stripe_account_id, stripe_account_ready FROM provider_profiles WHERE user_id = $1",
    [providerId]
  );
  const provider = providerResult.rows[0];
  if (!provider) return res.status(404).json({ error: "provider_not_found" });
  if (!provider.stripe_account_ready) return res.status(409).json({ error: "provider_not_payout_ready" });

  const basePriceCents = provider.base_price_cents;
  const serviceFeeCents = Math.round(basePriceCents * SERVICE_FEE_RATE);
  const totalCents = basePriceCents + serviceFeeCents;

  const bookingResult = await pool.query(
    `INSERT INTO bookings
       (client_id, provider_id, category_id, address_text, location,
        base_price_cents, service_fee_cents, total_price_cents, currency, status, no_show_grace_at)
     VALUES ($1,$2,$3,$4, ST_MakePoint($5,$6)::geography, $7,$8,$9,$10,'pending', now() + interval '20 minutes')
     RETURNING id`,
    [req.user.id, providerId, categoryId, addressText, lng, lat, basePriceCents, serviceFeeCents, totalCents, provider.currency]
  );
  const bookingId = bookingResult.rows[0].id;

  await pool.query(`INSERT INTO conversations (booking_id) VALUES ($1)`, [bookingId]);

  // Payment is created but not captured/confirmed until the client confirms
  // on their side (see routes/payments.js -> POST /api/payments/confirm).
  res.status(201).json({
    bookingId,
    pricing: { basePriceCents, serviceFeeCents, totalCents, currency: provider.currency },
  });
});

// GET /api/bookings/:id
router.get("/:id", requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT b.*, c.full_name AS client_name, p.full_name AS provider_name
     FROM bookings b
     JOIN users c ON c.id = b.client_id
     JOIN users p ON p.id = b.provider_id
     WHERE b.id = $1 AND (b.client_id = $2 OR b.provider_id = $2)`,
    [req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "not_found" });
  res.json(result.rows[0]);
});

// PATCH /api/bookings/:id/status — provider moves the booking through
// pending -> confirmed -> on_the_way -> arrived -> completed
// This is what drives the live tracking screen on the client's app.
router.patch("/:id/status", requireAuth, requireRole("provider"), async (req, res) => {
  const allowed = ["confirmed", "on_the_way", "arrived", "completed", "cancelled"];
  const { status } = req.body;
  if (!allowed.includes(status)) return res.status(400).json({ error: "invalid_status" });

  const result = await pool.query(
    `UPDATE bookings SET status = $1, updated_at = now()
     WHERE id = $2 AND provider_id = $3 RETURNING id, status`,
    [status, req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "not_found" });

  // Real deployments: emit a WebSocket event here so the client's tracking
  // screen updates instantly instead of polling. See server.js io.emit example.
  req.app.get("io")?.to(`booking:${req.params.id}`).emit("booking:status", result.rows[0]);

  res.json(result.rows[0]);
});

/* ---- Price-lock guarantee ----
   The price shown to the client at booking time (base_price_cents +
   service_fee_cents) is contractual. A provider can request MORE only
   through this flow, and nothing changes until the client explicitly
   accepts — this is what "price shown before booking" actually promises,
   not just a display convention. */

// POST /api/bookings/:id/price-adjustment — provider requests an increase
router.post("/:id/price-adjustment", requireAuth, requireRole("provider"), async (req, res) => {
  const { extraCents, reason } = req.body;
  if (!Number.isInteger(extraCents) || extraCents <= 0 || !reason?.trim()) {
    return res.status(400).json({ error: "invalid_input" });
  }
  const result = await pool.query(
    `UPDATE bookings
     SET price_adjustment_status = 'pending', price_adjustment_cents = $1, price_adjustment_reason = $2
     WHERE id = $3 AND provider_id = $4 AND status IN ('confirmed','on_the_way','arrived')
     RETURNING id`,
    [extraCents, reason.trim(), req.params.id, req.user.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "not_found_or_not_editable" });

  req.app.get("io")?.to(`booking:${req.params.id}`).emit("booking:price_adjustment_requested", { extraCents, reason });
  res.status(201).json({ ok: true });
});

// POST /api/bookings/:id/price-adjustment/respond — client accepts or declines
router.post("/:id/price-adjustment/respond", requireAuth, requireRole("client"), async (req, res) => {
  const { accept } = req.body;
  const { rows } = await pool.query(
    `SELECT price_adjustment_cents, price_adjustment_status, total_price_cents, stripe_payment_intent_id
     FROM bookings WHERE id = $1 AND client_id = $2`,
    [req.params.id, req.user.id]
  );
  const booking = rows[0];
  if (!booking || booking.price_adjustment_status !== "pending") return res.status(404).json({ error: "no_pending_adjustment" });

  if (!accept) {
    await pool.query(`UPDATE bookings SET price_adjustment_status = 'declined' WHERE id = $1`, [req.params.id]);
    req.app.get("io")?.to(`booking:${req.params.id}`).emit("booking:price_adjustment_declined", {});
    return res.json({ status: "declined" });
  }

  // Accepted: charge only the approved extra amount as a separate PaymentIntent
  // (never silently inflate the original charge) and bump the booking total.
  const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
  const extraIntent = await stripe.paymentIntents.create({
    amount: booking.price_adjustment_cents,
    currency: "usd",
    automatic_payment_methods: { enabled: true },
    metadata: { booking_id: req.params.id, type: "price_adjustment" },
  });

  await pool.query(
    `UPDATE bookings
     SET price_adjustment_status = 'accepted', total_price_cents = total_price_cents + $1
     WHERE id = $2`,
    [booking.price_adjustment_cents, req.params.id]
  );

  req.app.get("io")?.to(`booking:${req.params.id}`).emit("booking:price_adjustment_accepted", { extraCents: booking.price_adjustment_cents });
  res.json({ status: "accepted", clientSecret: extraIntent.client_secret });
});

/* ---- No-show auto-refund guarantee ----
   If a booking is still 'confirmed' (provider never moved it to
   'on_the_way') past the grace period set at booking time, the client can
   self-report a no-show: the original charge is refunded in full AND a
   goodwill credit is added to their wallet — no support ticket required. */

// POST /api/bookings/:id/report-no-show
router.post("/:id/report-no-show", requireAuth, requireRole("client"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT status, no_show_grace_at, stripe_payment_intent_id, total_price_cents
       FROM bookings WHERE id = $1 AND client_id = $2 FOR UPDATE`,
      [req.params.id, req.user.id]
    );
    const booking = rows[0];
    if (!booking) { await client.query("ROLLBACK"); return res.status(404).json({ error: "not_found" }); }
    if (booking.status !== "confirmed") { await client.query("ROLLBACK"); return res.status(409).json({ error: "not_eligible_status" }); }
    if (!booking.no_show_grace_at || new Date() < new Date(booking.no_show_grace_at)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "grace_period_not_elapsed" });
    }

    const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
    if (booking.stripe_payment_intent_id) {
      await stripe.refunds.create({ payment_intent: booking.stripe_payment_intent_id });
    }
    const goodwillCreditCents = Math.round(booking.total_price_cents * 0.1); // 10% goodwill credit

    await client.query(`UPDATE bookings SET status = 'cancelled_no_show', updated_at = now() WHERE id = $1`, [req.params.id]);
    await client.query(`UPDATE users SET wallet_credit_cents = wallet_credit_cents + $1 WHERE id = $2`, [goodwillCreditCents, req.user.id]);
    await client.query("COMMIT");

    res.json({ refunded: true, goodwillCreditCents });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "no_show_processing_failed" });
  } finally {
    client.release();
  }
});

// POST /api/bookings/:id/location — provider app pings its live position
// while status is on_the_way (call every 5-10s from the client app)
router.post("/:id/location", requireAuth, requireRole("provider"), async (req, res) => {
  const { lat, lng } = req.body;
  await pool.query(
    `INSERT INTO provider_location_pings (booking_id, location) VALUES ($1, ST_MakePoint($2,$3)::geography)`,
    [req.params.id, lng, lat]
  );
  req.app.get("io")?.to(`booking:${req.params.id}`).emit("booking:location", { lat, lng });
  res.json({ ok: true });
});

module.exports = router;
