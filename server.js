// ══════════════════════════════════════════════════════════════
//  OnePieceDaily — Backend  (Node + Express, no database)
//  Deploy to Render as a Web Service
// ══════════════════════════════════════════════════════════════
const express  = require("express");
const cors     = require("cors");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const app  = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || "onepiece-secret-change-in-production";

// ── CORS ─────────────────────────────────────────────────────
// Allow your Netlify domain + localhost for dev
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .concat([
    "http://localhost:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
  ]);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (curl, Postman) or matching origins
    if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) {
      cb(null, true);
    } else {
      cb(new Error(`CORS blocked: ${origin}`));
    }
  },
  credentials: true,
}));
app.use(express.json());

// ── In-Memory Store ────────────────────────────────────────────
// NOTE: Render free tier spins down after inactivity — data resets.
// For persistence upgrade to a paid plan or add a DB (e.g. Render Postgres).
const users   = new Map(); // username → { id, username, passwordHash, createdAt }
const scores  = new Map(); // `${userId}_${dayIndex}` → { userId, username, dayIndex, tries, solvedAt, xp }

// ── XP Formula ────────────────────────────────────────────────
// 1 try = 1000 xp, 2 tries = 800, ..., 6 tries = 500, fail = 0
function calcXP(tries) {
  const table = { 1: 1000, 2: 800, 3: 650, 4: 550, 5: 520, 6: 500 };
  return table[tries] || 0;
}

// ── Day Index (same formula as frontend) ──────────────────────
const EPOCH = new Date("2025-01-01T00:00:00Z").getTime();
function getDayIndex() {
  return Math.floor((Date.now() - EPOCH) / 86400000);
}

// ── Middleware: Authenticate JWT ───────────────────────────────
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
  if (users.has(key))
    return res.status(409).json({ error: "Username already taken" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), username, passwordHash, createdAt: Date.now() };
  users.set(key, user);

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
  res.status(201).json({ token, username: user.username });
});

// POST /api/login
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "Username and password are required" });

  const user = users.get(username.toLowerCase());
  if (!user) return res.status(401).json({ error: "Invalid username or password" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Invalid username or password" });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, username: user.username });
});

// GET /api/me  — verify token & return user info
app.get("/api/me", auth, (req, res) => {
  res.json({ username: req.user.username });
});

// ══════════════════════════════════════════════════════════════
//  SCORE ROUTES
// ══════════════════════════════════════════════════════════════

// POST /api/score  — submit today's result
app.post("/api/score", auth, (req, res) => {
  const { tries, dayIndex } = req.body || {};
  const day = typeof dayIndex === "number" ? dayIndex : getDayIndex();

  if (typeof tries !== "number" || tries < 1 || tries > 6)
    return res.status(400).json({ error: "tries must be 1–6" });

  const key = `${req.user.id}_${day}`;
  if (scores.has(key))
    return res.status(409).json({ error: "Score already submitted for today" });

  const xp = calcXP(tries);
  const entry = {
    userId:    req.user.id,
    username:  req.user.username,
    dayIndex:  day,
    tries,
    xp,
    solvedAt:  Date.now(),
  };
  scores.set(key, entry);
  res.status(201).json({ xp, tries });
});

// GET /api/leaderboard?day=N  — today's leaderboard (or specific day)
app.get("/api/leaderboard", (req, res) => {
  const day = req.query.day !== undefined ? parseInt(req.query.day) : getDayIndex();

  const board = [];
  scores.forEach(entry => {
    if (entry.dayIndex === day) board.push(entry);
  });

  board.sort((a, b) => {
    if (b.xp !== a.xp) return b.xp - a.xp;      // higher xp first
    return a.solvedAt - b.solvedAt;               // earlier solve time breaks ties
  });

  const ranked = board.map((e, i) => ({
    rank:     i + 1,
    username: e.username,
    tries:    e.tries,
    xp:       e.xp,
  }));

  res.json({ day, leaderboard: ranked });
});

// GET /api/leaderboard/alltime  — cumulative XP across all days
app.get("/api/leaderboard/alltime", (req, res) => {
  const totals = new Map(); // userId → { username, totalXP, wins }
  scores.forEach(entry => {
    if (!totals.has(entry.userId)) {
      totals.set(entry.userId, { username: entry.username, totalXP: 0, wins: 0 });
    }
    const t = totals.get(entry.userId);
    t.totalXP += entry.xp;
    if (entry.xp > 0) t.wins++;
  });

  const board = [];
  totals.forEach(t => board.push(t));
  board.sort((a, b) => b.totalXP - a.totalXP);

  const ranked = board.map((e, i) => ({
    rank:     i + 1,
    username: e.username,
    totalXP:  e.totalXP,
    wins:     e.wins,
  }));

  res.json({ leaderboard: ranked });
});

// GET /api/myscore?day=N  — check if current user submitted for a day
app.get("/api/myscore", auth, (req, res) => {
  const day = req.query.day !== undefined ? parseInt(req.query.day) : getDayIndex();
  const key = `${req.user.id}_${day}`;
  const entry = scores.get(key);
  if (!entry) return res.json({ submitted: false });
  res.json({ submitted: true, tries: entry.tries, xp: entry.xp });
});

// ── Health check ───────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ ok: true, users: users.size, scores: scores.size }));

app.listen(PORT, () => console.log(`OnePieceDaily API running on port ${PORT}`));
