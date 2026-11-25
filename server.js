const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { promisify } = require("util");
const scrypt = promisify(crypto.scrypt);

// Small dependency-free .env loader (keeps Node 18 compatibility).
(function loadDotEnv() {
  const file = path.join(__dirname, ".env");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
})();

const app = express();
const PORT = Number(process.env.PORT) || 5000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "fintrack.json");
const SESSION_COOKIE = "fintrack_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const INDIA_TZ = "Asia/Kolkata";
const indiaDateParts = (date = new Date()) => Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: INDIA_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
const indiaToday = () => { const p = indiaDateParts(); return `${p.year}-${p.month}-${p.day}`; };
const indiaMonth = () => indiaToday().slice(0, 7);
const authAttempts = new Map();
function rateLimit(bucket, limit, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip || req.socket.remoteAddress || "unknown"}`;
    const now = Date.now(); let state = authAttempts.get(key);
    if (!state || now - state.start > windowMs) state = { start: now, count: 0 };
    state.count++; authAttempts.set(key, state);
    if (state.count > limit) return res.status(429).json({ error: "Too many attempts. Please wait and try again." });
    next();
  };
}
const authLimiter = rateLimit("auth", 10, 15 * 60 * 1000);
const chatLimiter = rateLimit("chat", 30, 60 * 1000);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

function loadData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { users: [], transactions: [], budgets: [], goals: [] };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      budgets: Array.isArray(parsed.budgets) ? parsed.budgets : [],
      goals: Array.isArray(parsed.goals) ? parsed.goals : []
    };
  } catch (error) {
    console.error("Could not read data/fintrack.json:", error.message);
    throw new Error("Your FinTrack data file could not be read. Make a backup before replacing it.");
  }
}
let db = loadData();
function saveData() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temp = DATA_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DATA_FILE);
}
const id = () => Date.now().toString(36) + crypto.randomBytes(5).toString("hex");
const validAmount = n => Number.isFinite(Number(n)) && Number(n) > 0;
const monthOf = date => String(date || "").slice(0, 7);
const safeUser = user => ({ id: user.id, name: user.name, email: user.email });

// A persistent random signing key keeps users signed in across server restarts.
function getSessionSecret() {
  const envSecret = process.env.SESSION_SECRET;
  if (envSecret && envSecret.length >= 32) return envSecret;
  const secretFile = path.join(DATA_DIR, "session-secret.txt");
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(48).toString("hex"), { mode: 0o600 });
  return fs.readFileSync(secretFile, "utf8").trim();
}
const SESSION_SECRET = getSessionSecret();
function sign(value) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("base64url");
}
function makeSession(userId) {
  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function readSession(req) {
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map(part => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.sub || data.exp < Math.floor(Date.now() / 1000)) return null;
    return db.users.find(user => user.id === data.sub) || null;
  } catch { return null; }
}
function setSessionCookie(res, userId) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${encodeURIComponent(makeSession(userId))}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}${secure}`);
}
function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}
function requireAuth(req, res, next) {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Please log in to continue." });
  req.user = user;
  next();
}
const owned = (items, userId) => items.filter(item => item.userId === userId);

// Auth endpoints
app.post("/api/auth/signup", authLimiter, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 60);
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (name.length < 2) return res.status(400).json({ error: "Please enter your name (at least 2 characters)." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) return res.status(400).json({ error: "Please enter a valid email address." });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: "Password must be between 8 and 128 characters." });
  if (db.users.some(user => user.email === email)) return res.status(409).json({ error: "An account with this email already exists. Please log in." });

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = (await scrypt(password, salt, 64)).toString("hex");
  const user = { id: id(), name, email, salt, passwordHash, createdAt: new Date().toISOString() };
  db.users.push(user);

  // Preserve any records from the earlier single-user version by assigning them
  // to the first account created after this upgrade.
  const hasUnownedRecords = [...db.transactions, ...db.budgets, ...db.goals].some(item => !item.userId);
  if (hasUnownedRecords) {
    db.transactions.forEach(item => { if (!item.userId) item.userId = user.id; });
    db.budgets.forEach(item => { if (!item.userId) item.userId = user.id; });
    db.goals.forEach(item => { if (!item.userId) item.userId = user.id; });
  }
  saveData();
  setSessionCookie(res, user.id);
  res.status(201).json({ user: safeUser(user) });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = db.users.find(item => item.email === email);
  if (!user) return res.status(401).json({ error: "Incorrect email or password." });
  const attempted = await scrypt(password, user.salt, 64);
  const actual = Buffer.from(user.passwordHash, "hex");
  if (attempted.length !== actual.length || !crypto.timingSafeEqual(attempted, actual)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  setSessionCookie(res, user.id);
  res.json({ user: safeUser(user) });
});

app.post("/api/auth/logout", (req, res) => { clearSessionCookie(res); res.json({ success: true }); });
app.get("/api/auth/me", (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  res.json({ user: safeUser(user) });
});

app.get("/api/health", (req, res) => res.json({ status: "ok", app: "FinTrack" }));

// All personal-finance endpoints require a valid session and filter by userId.
app.use("/api", (req, res, next) => {
  if (["/health", "/auth/signup", "/auth/login", "/auth/logout", "/auth/me"].includes(req.path)) return next();
  // Reject cross-origin browser mutations. SameSite=Lax remains an additional layer.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin) {
    const expected = `${req.protocol}://${req.get("host")}`;
    if (req.headers.origin !== expected) return res.status(403).json({ error: "Cross-origin request blocked." });
  }
  requireAuth(req, res, next);
});

app.get("/api/transactions", (req, res) => {
  res.json([...owned(db.transactions, req.user.id)].sort((a, b) => b.date.localeCompare(a.date)));
});
app.post("/api/transactions", (req, res) => {
  const { title, amount, type, category, date, note } = req.body || {};
  if (!title || !validAmount(amount) || !["income", "expense"].includes(type) || !category || !/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return res.status(400).json({ error: "Enter a title, positive amount, valid type, category and date." });
  const item = { id: id(), userId: req.user.id, title: String(title).trim().slice(0, 80), amount: Number(amount), type, category: String(category).trim().slice(0, 40), date, note: String(note || "").slice(0, 200) };
  db.transactions.push(item); saveData(); res.status(201).json(item);
});
app.delete("/api/transactions/:id", (req, res) => {
  const old = db.transactions.length;
  db.transactions = db.transactions.filter(t => !(t.id === req.params.id && t.userId === req.user.id));
  if (old === db.transactions.length) return res.status(404).json({ error: "Transaction not found." });
  saveData(); res.json({ success: true });
});
app.get("/api/summary", (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : indiaMonth();
  const current = owned(db.transactions, req.user.id).filter(t => monthOf(t.date) === month);
  const income = current.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expenses = current.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const categories = {};
  current.filter(t => t.type === "expense").forEach(t => categories[t.category] = (categories[t.category] || 0) + t.amount);
  res.json({ month, income, expenses, balance: income - expenses, savingsRate: income ? Math.round(((income - expenses) / income) * 100) : 0, categories: Object.entries(categories).map(([name, amount]) => ({ name, amount })), recent: [...current].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6) });
});
app.get("/api/budgets", (req, res) => res.json(owned(db.budgets, req.user.id)));
app.post("/api/budgets", (req, res) => {
  const { category, limit, month } = req.body || {};
  if (!category || !validAmount(limit) || !/^\d{4}-\d{2}$/.test(month || "")) return res.status(400).json({ error: "Enter a category, positive limit and month." });
  const key = String(category).trim().toLowerCase();
  let item = db.budgets.find(b => b.userId === req.user.id && b.category.toLowerCase() === key && b.month === month);
  if (item) item.limit = Number(limit);
  else { item = { id: id(), userId: req.user.id, category: String(category).trim(), limit: Number(limit), month }; db.budgets.push(item); }
  saveData(); res.json(item);
});
app.delete("/api/budgets/:id", (req, res) => {
  const old = db.budgets.length;
  db.budgets = db.budgets.filter(b => !(b.id === req.params.id && b.userId === req.user.id));
  if (old === db.budgets.length) return res.status(404).json({ error: "Budget not found." });
  saveData(); res.json({ success: true });
});
app.get("/api/goals", (req, res) => res.json(owned(db.goals, req.user.id)));
app.post("/api/goals", (req, res) => {
  const { name, target, deadline } = req.body || {};
  if (!name || !validAmount(target)) return res.status(400).json({ error: "Enter a goal name and positive target." });
  const goal = { id: id(), userId: req.user.id, name: String(name).trim().slice(0, 80), target: Number(target), saved: 0, deadline: deadline || "" };
  db.goals.push(goal); saveData(); res.status(201).json(goal);
});
app.patch("/api/goals/:id", (req, res) => {
  const goal = db.goals.find(g => g.id === req.params.id && g.userId === req.user.id);
  if (!goal) return res.status(404).json({ error: "Goal not found." });
  if (!validAmount(req.body.amount)) return res.status(400).json({ error: "Enter a positive contribution." });
  const contribution = Math.min(goal.target - goal.saved, Number(req.body.amount));
  if (contribution <= 0) return res.status(400).json({ error: "This goal has already reached its target." });
  goal.saved = Math.min(goal.target, goal.saved + contribution);
  // Treat a goal contribution as money moved out of spendable cash flow.
  db.transactions.push({ id: id(), userId: req.user.id, title: `Savings contribution: ${goal.name}`, amount: contribution, type: "expense", category: "Savings", date: indiaToday(), note: "Automatically recorded from savings-goal contribution" });
  saveData(); res.json(goal);
});
app.delete("/api/goals/:id", (req, res) => {
  const old = db.goals.length;
  db.goals = db.goals.filter(g => !(g.id === req.params.id && g.userId === req.user.id));
  if (old === db.goals.length) return res.status(404).json({ error: "Goal not found." });
  saveData(); res.json({ success: true });
});


// Hybrid ML endpoint. The Python models receive only the authenticated user's records.
app.get("/api/ml/insights", requireAuth, (req, res) => {
  const payload = {
    transactions: owned(db.transactions, req.user.id),
    budgets: owned(db.budgets, req.user.id),
    goals: owned(db.goals, req.user.id)
  };
  const python = process.env.PYTHON_BIN || "python3";
  const child = spawn(python, [path.join(__dirname, "ml", "ml_engine.py")], {
    cwd: __dirname, stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => stdout += chunk.toString());
  child.stderr.on("data", chunk => stderr += chunk.toString());
  child.on("error", err => res.status(503).json({ error: "Python ML engine unavailable. Install ml/requirements.txt and ensure python3 is available.", details: err.message }));
  child.on("close", code => {
    if (res.headersSent) return;
    if (code !== 0) return res.status(500).json({ error: "ML analysis failed.", details: stderr.slice(-1200) });
    try { res.json(JSON.parse(stdout)); }
    catch { res.status(500).json({ error: "ML engine returned invalid output.", details: stderr.slice(-1200) }); }
  });
  child.stdin.end(JSON.stringify(payload));
});

function buildLocalReply(question, userId) {
  const q = question.toLowerCase(); const nowMonth = indiaMonth();
  const userTransactions = owned(db.transactions, userId);
  const monthTx = userTransactions.filter(t => monthOf(t.date) === nowMonth);
  const income = monthTx.filter(t => t.type === "income").reduce((s, t) => s + t.amount, 0);
  const expenses = monthTx.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const balance = income - expenses; const byCategory = {};
  monthTx.filter(t => t.type === "expense").forEach(t => byCategory[t.category] = (byCategory[t.category] || 0) + t.amount);
  const top = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];
  const inr = n => "₹" + Math.round(n).toLocaleString("en-IN");
  if (/hello|hi\b|hey/.test(q)) return "Hi! I'm FinTrack Assistant. I can help you understand your recorded spending, budgets and savings goals.";
  if (/top|highest|most|category|spend|expense/.test(q)) return top ? `Your largest recorded expense category this month is ${top[0]} at ${inr(top[1])}. Total expenses are ${inr(expenses)}. Consider reviewing this category and setting a realistic budget.` : "There are no expense records for this month yet. Add a few transactions and ask me again.";
  if (/save|saving|savings/.test(q)) { const rate = income ? Math.round(balance / income * 100) : 0; return `This month, recorded income is ${inr(income)} and expenses are ${inr(expenses)}. Your net cash flow is ${inr(balance)} and your savings rate is ${rate}%. A practical first step is to set a small, consistent savings target after essential expenses.`; }
  if (/budget/.test(q)) { const budgets = owned(db.budgets, userId).filter(b => b.month === nowMonth); if (!budgets.length) return "You haven't set a budget for this month. Add category budgets in the Monthly Budgets panel."; return "Your budgets this month: " + budgets.map(b => { const spent = monthTx.filter(t => t.type === "expense" && t.category.toLowerCase() === b.category.toLowerCase()).reduce((s, t) => s + t.amount, 0); return `${b.category}: ${inr(spent)} spent of ${inr(b.limit)}${spent > b.limit ? " (over budget)" : ""}`; }).join("; ") + "."; }
  if (/goal/.test(q)) { const goals = owned(db.goals, userId); if (!goals.length) return "You have no savings goals yet. Create one in the Savings Goals panel."; return "Your savings goals: " + goals.map(g => `${g.name}: ${inr(g.saved)} saved of ${inr(g.target)}`).join("; ") + "."; }
  if (/income|cash flow|balance|overview|summary/.test(q)) return `For ${nowMonth}, your recorded income is ${inr(income)}, expenses are ${inr(expenses)}, and net cash flow is ${inr(balance)}.`;
  return "Try asking: “Give me my monthly summary”, “Where am I spending the most?”, “How can I save more?”, “Show my budgets”, or “How are my savings goals doing?”";
}
app.post("/api/chat", chatLimiter, async (req, res) => {
  const question = String(req.body.message || "").trim().slice(0, 1500);
  if (!question) return res.status(400).json({ error: "Type a message first." });
  const userId = req.user.id;
  if (process.env.OPENAI_API_KEY) {
    try {
      const month = indiaMonth();
      const snapshot = { month, transactions: owned(db.transactions, userId).filter(t => monthOf(t.date) === month), budgets: owned(db.budgets, userId).filter(b => b.month === month), goals: owned(db.goals, userId) };
      const response = await fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", messages: [{ role: "system", content: "You are FinTrack Assistant. Give concise, cautious personal budgeting explanations based only on this user's supplied app data. Do not claim to connect to banks. Never ask for passwords, OTPs, UPI PINs or card PINs. Do not give investment, tax or legal advice. User data: " + JSON.stringify(snapshot) }, { role: "user", content: question }], temperature: 0.4 }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.error?.message || "AI provider request failed");
      return res.json({ reply: result.choices?.[0]?.message?.content || buildLocalReply(question, userId), mode: "AI" });
    } catch (error) { console.error("AI chat fallback:", error.message); return res.json({ reply: buildLocalReply(question, userId) + "\n\n(Using local assistant because the AI service was unavailable.)", mode: "local" }); }
  }
  res.json({ reply: buildLocalReply(question, userId), mode: "local" });
});
app.get("/api/export", (req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="fintrack-backup.json"');
  res.json({ transactions: owned(db.transactions, req.user.id), budgets: owned(db.budgets, req.user.id), goals: owned(db.goals, req.user.id) });
});
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: "Server error. Check the VS Code terminal." }); });
app.listen(PORT, () => console.log(`\nFinTrack is running at http://localhost:${PORT}\nData file: ${DATA_FILE}\nAuthentication: enabled\nAI chatbot: ${process.env.OPENAI_API_KEY ? "OpenAI API configured" : "local fallback mode"}\n`));
