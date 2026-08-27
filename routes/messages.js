const express = require("express");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// GET /api/bookings/:bookingId/messages
router.get("/:bookingId/messages", requireAuth, async (req, res) => {
  const convo = await pool.query("SELECT id FROM conversations WHERE booking_id = $1", [req.params.bookingId]);
  if (!convo.rows.length) return res.status(404).json({ error: "conversation_not_found" });

  const messages = await pool.query(
    "SELECT id, sender_id, content, sent_at FROM messages WHERE conversation_id = $1 ORDER BY sent_at ASC",
    [convo.rows[0].id]
  );
  res.json({ messages: messages.rows });
});

// POST /api/bookings/:bookingId/messages
router.post("/:bookingId/messages", requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: "empty_message" });

  const convo = await pool.query("SELECT id FROM conversations WHERE booking_id = $1", [req.params.bookingId]);
  if (!convo.rows.length) return res.status(404).json({ error: "conversation_not_found" });

  const result = await pool.query(
    `INSERT INTO messages (conversation_id, sender_id, content) VALUES ($1,$2,$3)
     RETURNING id, sender_id, content, sent_at`,
    [convo.rows[0].id, req.user.id, content.trim()]
  );

  const message = result.rows[0];
  // Real-time push to the other participant (see server.js socket setup)
  req.app.get("io")?.to(`booking:${req.params.bookingId}`).emit("message:new", message);

  res.status(201).json(message);
});

module.exports = router;
