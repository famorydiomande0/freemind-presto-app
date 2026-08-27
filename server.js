require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");

const authRoutes = require("./routes/auth");
const providerRoutes = require("./routes/providers");
const bookingRoutes = require("./routes/bookings");
const paymentRoutes = require("./routes/payments");
const messageRoutes = require("./routes/messages");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN } });
app.set("io", io);

app.use(cors({ origin: process.env.CORS_ORIGIN }));

// Stripe webhooks need the raw body for signature verification, so this
// route is registered BEFORE the global express.json() middleware.
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/providers", providerRoutes);
app.use("/api/bookings", bookingRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/bookings", messageRoutes); // adds /:bookingId/messages under the bookings prefix

// Socket.IO: each client joins a room per booking to receive live status,
// location, and chat updates for that booking only.
io.on("connection", (socket) => {
  socket.on("booking:join", (bookingId) => {
    socket.join(`booking:${bookingId}`);
  });
});

const port = process.env.PORT || 4000;
server.listen(port, () => {
  console.log(`Prestō API listening on port ${port}`);
});
