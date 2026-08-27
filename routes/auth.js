const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { z } = require("zod");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const router = express.Router();

const signupSchema = z.object({
  role: z.enum(["client", "provider"]),
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1),
  preferredLang: z.enum(["fr", "en", "es", "pt", "de"]).default("fr"),
});

// POST /api/auth/signup
router.post("/signup", async (req, res) => {
  const parsed = signupSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", details: parsed.error.flatten() });
  const { role, email, password, fullName, preferredLang } = parsed.data;

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  if (existing.rows.length) return res.status(409).json({ error: "email_taken" });

  const passwordHash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO users (role, email, password_hash, full_name, preferred_lang)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, role, email, full_name, preferred_lang`,
    [role, email, passwordHash, fullName, preferredLang]
  );
  const user = result.rows[0];

  // Providers get an empty profile row to fill in later (category, price, location...)
  if (role === "provider") {
    await pool.query(
      `INSERT INTO provider_profiles (user_id, category_id, base_price_cents)
       VALUES ($1, 'handyman', 0)`,
      [user.id]
    );
  }

  const token = jwt.sign({ id: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
  res.status(201).json({ token, user });
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "invalid_input" });

  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: "invalid_credentials" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: "invalid_credentials" });

  const token = jwt.sign({ id: user.id, role: user.role, email: user.email }, process.env.JWT_SECRET, {
    expiresIn: "30d",
  });
  res.json({
    token,
    user: { id: user.id, role: user.role, email: user.email, fullName: user.full_name, preferredLang: user.preferred_lang },
  });
});

// POST /api/auth/identity-verification-session
// Creates a real Stripe Identity verification session for a provider and
// returns the client_secret the mobile/web app uses to open Stripe's
// hosted verification flow (ID scan + selfie).
router.post("/identity-verification-session", requireAuth, requireRole("provider"), async (req, res) => {
  const session = await stripe.identity.verificationSessions.create({
    type: "document",
    metadata: { user_id: req.user.id },
    options: { document: { require_matching_selfie: true } },
    return_url: process.env.STRIPE_IDENTITY_RETURN_URL,
  });

  await pool.query(
    `UPDATE provider_profiles SET identity_status = 'pending' WHERE user_id = $1`,
    [req.user.id]
  );

  res.json({ clientSecret: session.client_secret, sessionId: session.id });
});

module.exports = router;
