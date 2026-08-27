const express = require("express");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

// GET /api/providers?lat=48.86&lng=2.35&radiusKm=10&category=handyman&onlyAvailable=true&sort=nearest
// Real geo query using PostGIS — this is what the "dispatch board" and
// provider list screens in the frontend should call instead of mock data.
router.get("/", async (req, res) => {
  const { lat, lng, radiusKm = 15, category, onlyAvailable, sort = "nearest" } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: "lat_lng_required" });

  const params = [lng, lat, Number(radiusKm) * 1000];
  let where = `ST_DWithin(pp.location, ST_MakePoint($1, $2)::geography, $3)`;
  if (category) {
    params.push(category);
    where += ` AND pp.category_id = $${params.length}`;
  }
  if (onlyAvailable === "true") {
    where += ` AND pp.is_available_now = true`;
  }

  const orderBy =
    sort === "cheapest" ? "pp.base_price_cents ASC" :
    sort === "topRated" ? "avg_rating DESC NULLS LAST" :
    "distance_m ASC";

  const query = `
    SELECT
      u.id, u.full_name,
      pp.category_id, pp.base_price_cents, pp.currency, pp.is_available_now,
      pp.identity_status, pp.years_experience,
      ST_Distance(pp.location, ST_MakePoint($1, $2)::geography) AS distance_m,
      COALESCE(AVG(r.rating), 0) AS avg_rating,
      COUNT(r.id) AS review_count
    FROM provider_profiles pp
    JOIN users u ON u.id = pp.user_id
    LEFT JOIN reviews r ON r.provider_id = u.id
    WHERE ${where}
    GROUP BY u.id, pp.category_id, pp.base_price_cents, pp.currency, pp.is_available_now,
             pp.identity_status, pp.years_experience, pp.location
    ORDER BY ${orderBy}
    LIMIT 50;
  `;

  const result = await pool.query(query, params);
  res.json({
    providers: result.rows.map((r) => ({
      id: r.id,
      name: r.full_name,
      categoryId: r.category_id,
      priceCents: r.base_price_cents,
      currency: r.currency,
      available: r.is_available_now,
      verified: r.identity_status === "verified",
      yearsExperience: r.years_experience,
      distanceKm: Math.round((r.distance_m / 1000) * 10) / 10,
      rating: Math.round(Number(r.avg_rating) * 10) / 10,
      reviewCount: Number(r.review_count),
    })),
  });
});

// GET /api/providers/:id — full profile for the provider detail screen
router.get("/:id", async (req, res) => {
  const result = await pool.query(
    `SELECT u.id, u.full_name, pp.*, COALESCE(AVG(r.rating),0) AS avg_rating, COUNT(r.id) AS review_count
     FROM provider_profiles pp
     JOIN users u ON u.id = pp.user_id
     LEFT JOIN reviews r ON r.provider_id = u.id
     WHERE u.id = $1
     GROUP BY u.id, pp.user_id`,
    [req.params.id]
  );
  if (!result.rows.length) return res.status(404).json({ error: "not_found" });
  res.json(result.rows[0]);
});

// PATCH /api/providers/me/availability — the toggle the provider flips in their app
router.patch("/me/availability", requireAuth, requireRole("provider"), async (req, res) => {
  const { available, lat, lng } = req.body;
  await pool.query(
    `UPDATE provider_profiles
     SET is_available_now = $1, availability_updated_at = now(),
         location = ST_MakePoint($2, $3)::geography
     WHERE user_id = $4`,
    [!!available, lng, lat, req.user.id]
  );
  res.json({ ok: true });
});

// POST /api/providers/me/stripe-onboarding-link
// Creates (if needed) a Stripe Connect account for the provider and returns
// the hosted onboarding URL — this is the real "get paid" flow.
router.post("/me/stripe-onboarding-link", requireAuth, requireRole("provider"), async (req, res) => {
  const { rows } = await pool.query("SELECT stripe_account_id FROM provider_profiles WHERE user_id = $1", [req.user.id]);
  let accountId = rows[0]?.stripe_account_id;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "standard",
      email: req.user.email,
    });
    accountId = account.id;
    await pool.query("UPDATE provider_profiles SET stripe_account_id = $1 WHERE user_id = $2", [accountId, req.user.id]);
  }

  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: `${process.env.CORS_ORIGIN}/provider/stripe/refresh`,
    return_url: `${process.env.CORS_ORIGIN}/provider/stripe/complete`,
    type: "account_onboarding",
  });

  res.json({ url: link.url });
});

module.exports = router;
