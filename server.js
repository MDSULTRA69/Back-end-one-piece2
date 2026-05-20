// ══════════════════════════════════════════════════════════════
//  OnePieceDaily — Backend  (Node + Express + PostgreSQL)
//  Deploy to Render as a Web Service
// ══════════════════════════════════════════════════════════════
const express  = require("express");
const cors     = require("cors");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");

const app  = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "onepiece-secret-change-in-production";

// ── CORS ──────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// ── PostgreSQL ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// ── Create Tables on Startup ──────────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      username     TEXT UNIQUE NOT NULL,
      username_key TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at   BIGINT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      user_id    TEXT NOT NULL,
      username   TEXT NOT NULL,
      day_index  INT  NOT NULL,
      tries      INT  NOT NULL,
      xp         INT  NOT NULL,
      solved_at  BIGINT NOT NULL,
      PRIMARY KEY (user_id, day_index)
    );
  `);
  console.log("Database tables ready.");
}

// ── XP Formula ────────────────────────────────────────────────
function calcXP(tries) {
  const table = { 1: 1000, 2: 800, 3: 650, 4: 550, 5: 520, 6: 500 };
  return table[tries] || 0;
}

// ── Day Index ─────────────────────────────────────────────────
const EPOCH = new Date("2025-01-01T00:00:00Z").getTime();
function getDayIndex() {
  return Math.floor((Date.now() - EPOCH) / 86400000);
}

// ── Auth Middleware ───────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ══════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════════

// POST /api/register
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "Username and password are required" });
  if (username.length < 3 || username.length > 20)
    return res.status(400).json({ error: "Username must be 3–20 characters" });
  if (password.length < 6)
    return res.status(400).json({ error: "Password must be at least 6 characters" });

  const key = username.toLowerCase();
  try {
    const existing = await pool.query("SELECT id FROM users WHERE username_key = $1", [key]);
    if (existing.rows.length > 0)
      return res.status(409).json({ error: "Username already taken" });

    const passwordHash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    await pool.query(
      "INSERT INTO users (id, username, username_key, password_hash, created_at) VALUES ($1,$2,$3,$4,$5)",
      [id, username, key, passwordHash, Date.now()]
    );

    const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: "30d" });
    res.status(201).json({ token, username });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/login
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "Username and password are required" });

  try {
    const result = await pool.query("SELECT * FROM users WHERE username_key = $1", [username.toLowerCase()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: "Invalid username or password" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Invalid username or password" });

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, username: user.username });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/me
app.get("/api/me", auth, (req, res) => {
  res.json({ username: req.user.username });
});

// ══════════════════════════════════════════════════════════════
//  SCORE ROUTES
// ══════════════════════════════════════════════════════════════

// POST /api/score
app.post("/api/score", auth, async (req, res) => {
  const { tries, dayIndex } = req.body || {};
  const day = typeof dayIndex === "number" ? dayIndex : getDayIndex();

  if (typeof tries !== "number" || tries < 1 || tries > 6)
    return res.status(400).json({ error: "tries must be 1–6" });

  const xp = calcXP(tries);
  try {
    await pool.query(
      `INSERT INTO scores (user_id, username, day_index, tries, xp, solved_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, day_index) DO NOTHING`,
      [req.user.id, req.user.username, day, tries, xp, Date.now()]
    );
    res.status(201).json({ xp, tries });
  } catch (err) {
    console.error("Score submit error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/leaderboard?day=N
app.get("/api/leaderboard", async (req, res) => {
  const day = req.query.day !== undefined ? parseInt(req.query.day) : getDayIndex();
  try {
    const result = await pool.query(
      `SELECT username, tries, xp, solved_at
       FROM scores
       WHERE day_index = $1
       ORDER BY xp DESC, solved_at ASC`,
      [day]
    );
    const ranked = result.rows.map((e, i) => ({
      rank: i + 1,
      username: e.username,
      tries: e.tries,
      xp: e.xp,
    }));
    res.json({ day, leaderboard: ranked });
  } catch (err) {
    console.error("Leaderboard error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/leaderboard/alltime
app.get("/api/leaderboard/alltime", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT username, SUM(xp) AS total_xp, COUNT(*) AS wins
       FROM scores
       WHERE xp > 0
       GROUP BY username
       ORDER BY total_xp DESC`
    );
    const ranked = result.rows.map((e, i) => ({
      rank: i + 1,
      username: e.username,
      totalXP: parseInt(e.total_xp),
      wins: parseInt(e.wins),
    }));
    res.json({ leaderboard: ranked });
  } catch (err) {
    console.error("All-time leaderboard error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/myscore?day=N
app.get("/api/myscore", auth, async (req, res) => {
  const day = req.query.day !== undefined ? parseInt(req.query.day) : getDayIndex();
  try {
    const result = await pool.query(
      "SELECT tries, xp FROM scores WHERE user_id = $1 AND day_index = $2",
      [req.user.id, day]
    );
    if (result.rows.length === 0) return res.json({ submitted: false });
    res.json({ submitted: true, tries: result.rows[0].tries, xp: result.rows[0].xp });
  } catch (err) {
    console.error("My score error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/health
app.get("/api/health", async (_, res) => {
  try {
    const users  = await pool.query("SELECT COUNT(*) FROM users");
    const scores = await pool.query("SELECT COUNT(*) FROM scores");
    res.json({ ok: true, users: parseInt(users.rows[0].count), scores: parseInt(scores.rows[0].count) });
  } catch {
    res.status(500).json({ ok: false });
  }
});

// ── Start ─────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`OnePieceDaily API running on port ${PORT}`));
}).catch(err => {
  console.error("Failed to initialize DB:", err);
  process.exit(1);
});
