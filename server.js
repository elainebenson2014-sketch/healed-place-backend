/**
 * The Healed Place · Wealth — Backend API (Supabase Edition)
 * Replaces the in-memory Maps with a real Supabase/PostgreSQL database.
 *
 * Changes from v1:
 *  - Auth delegated entirely to Supabase (no more bcrypt/JWT in this server)
 *  - All data reads/writes go through Supabase client
 *  - Service role key used server-side (never exposed to browser)
 *  - Row Level Security enforced at the database layer
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

// ─── VALIDATE ENV ─────────────────────────────────────────────────────────────
const REQUIRED = ["ANTHROPIC_API_KEY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`❌  Missing required env var: ${key}`);
    process.exit(1);
  }
}

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 4000;

// Supabase admin client — uses SERVICE ROLE KEY (full database access, server-only)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Anthropic client
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(express.json({ limit: "1mb" }));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://localhost:3000").split(",");
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));

// ─── RATE LIMITERS ────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const aiLimiter      = rateLimit({ windowMs: 60 * 1000, max: 10,
  message: { error: "AI rate limit reached — wait a moment." } });

app.use(generalLimiter);

// ─── AUTH MIDDLEWARE (Supabase JWT) ───────────────────────────────────────────
// The frontend uses Supabase Auth to log in and gets a JWT.
// We verify that JWT here using the Supabase admin client.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided." });
  }

  const token = header.split(" ")[1];

  // Supabase verifies the JWT and returns the user
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }

  req.user = user;     // { id, email, ... }
  req.token = token;
  next();
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the The Healed Place · Wealth AI Coach — a warm, expert, faith-centered financial stewardship coach.

Personality: encouraging, never shame-based, blend biblical wisdom with practical expertise, teach one concept at a time, celebrate every win.

Capabilities: budget generation (10-10-80 Kingdom method), debt reduction (snowball), savings goals, financial literacy, weekly check-ins, stewardship devotionals, AI journal analysis, spending pattern insights, goal tracking, accountability partner guidance, family budgeting, church workshops.

Format with **bold** for key points, short bullets when helpful. End with scripture or encouragement when relevant.
Current date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "The Healed Place · Wealth API (Supabase)", version: "2.1.0" });
});

// ── AUTH ─────────────────────────────────────────────────────────────────────
// NOTE: Registration and login are handled entirely by the Supabase client
// in the React app. The server just verifies the JWT on protected routes.
// See frontend-auth.js for the client-side auth code.

/**
 * GET /auth/me
 * Returns the current user's profile from the database.
 */
app.get("/auth/me", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, email, phase, subscription, created_at")
    .eq("id", req.user.id)
    .single();

  if (error) return res.status(404).json({ error: "Profile not found." });
  res.json(data);
});

// ── FINANCIAL PLAN ────────────────────────────────────────────────────────────

/**
 * POST /plan  — upsert (create or update) the user's financial plan
 */
app.post("/plan", requireAuth, async (req, res) => {
  const { income, expenses, debt, savings, goals, stress, timeline, members } = req.body;

  if (!income || !expenses) {
    return res.status(400).json({ error: "Income and expenses are required." });
  }

  // Upsert: if plan exists update it, otherwise create it
  const { data, error } = await supabase
    .from("financial_plans")
    .upsert({
      user_id:  req.user.id,
      income:   parseFloat(income),
      expenses: parseFloat(expenses),
      debt:     parseFloat(debt)    || 0,
      savings:  parseFloat(savings) || 0,
      goals:    goals    || "",
      stress:   stress   || "",
      timeline: timeline || "1-2 years",
      members:  members  || [],
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" })
    .select()
    .single();

  if (error) {
    console.error("Plan upsert error:", error);
    return res.status(500).json({ error: "Failed to save plan." });
  }

  console.log(`💰  Plan saved for: ${req.user.email}`);
  res.json({ success: true, plan: data });
});

/**
 * GET /plan  — load the user's financial plan
 */
app.get("/plan", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("financial_plans")
    .select("*")
    .eq("user_id", req.user.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    return res.status(404).json({ error: "No financial plan found. Please complete the intake form." });
  }

  res.json(data);
});

// ── JOURNAL ───────────────────────────────────────────────────────────────────

/**
 * POST /journal  — save a journal entry (with optional AI insight)
 */
app.post("/journal", requireAuth, aiLimiter, async (req, res) => {
  const { mood, mood_label, body, generate_insight } = req.body;

  if (!body || body.trim().length < 10) {
    return res.status(400).json({ error: "Journal entry must be at least 10 characters." });
  }

  let ai_insight = null;

  // Optionally generate an AI insight in the same request
  if (generate_insight) {
    try {
      const plan = await getUserPlan(req.user.id);
      const planCtx = plan ? `User's finances: Income $${plan.income}/mo, Debt $${plan.debt}, Savings $${plan.savings}.` : "";

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `Financial journal entry. Mood: ${mood_label || "Neutral"} ${mood || ""}. Entry: "${body.trim()}"\n${planCtx}\n\nProvide a 2-3 sentence warm, faith-centered insight and one specific action.`,
        }],
      });
      ai_insight = response.content?.[0]?.text || null;
    } catch (err) {
      console.error("Journal insight error:", err);
      // Non-fatal — save entry without insight
    }
  }

  const { data, error } = await supabase
    .from("journal_entries")
    .insert({
      user_id:    req.user.id,
      mood:       mood || "😊",
      mood_label: mood_label || "Neutral",
      body:       body.trim(),
      ai_insight,
    })
    .select()
    .single();

  if (error) {
    console.error("Journal save error:", error);
    return res.status(500).json({ error: "Failed to save journal entry." });
  }

  res.status(201).json({ success: true, entry: data });
});

/**
 * GET /journal  — list the user's journal entries (newest first)
 */
app.get("/journal", requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  const { data, error } = await supabase
    .from("journal_entries")
    .select("*")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) return res.status(500).json({ error: "Failed to load journal." });
  res.json(data || []);
});

// ── SAVINGS GOALS ─────────────────────────────────────────────────────────────

/**
 * GET /savings  — list all savings goals
 */
app.get("/savings", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("savings_goals")
    .select("*")
    .eq("user_id", req.user.id)
    .eq("status", "active")
    .order("created_at");

  if (error) return res.status(500).json({ error: "Failed to load savings goals." });
  res.json(data || []);
});

/**
 * POST /savings  — create a new savings goal
 */
app.post("/savings", requireAuth, async (req, res) => {
  const { name, icon, target, current, monthly_contribution, target_date } = req.body;

  if (!name || !target) return res.status(400).json({ error: "Name and target are required." });

  const { data, error } = await supabase
    .from("savings_goals")
    .insert({ user_id: req.user.id, name, icon: icon || "💰", target, current: current || 0, monthly_contribution: monthly_contribution || 0, target_date })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "Failed to create savings goal." });
  res.status(201).json(data);
});

/**
 * PATCH /savings/:id  — update a savings goal (e.g. add deposit)
 */
app.patch("/savings/:id", requireAuth, async (req, res) => {
  const { current, status } = req.body;

  const { data, error } = await supabase
    .from("savings_goals")
    .update({ current, status, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)   // RLS: user can only update their own
    .select()
    .single();

  if (error) return res.status(500).json({ error: "Failed to update savings goal." });
  res.json(data);
});

// ── DEBT ACCOUNTS ─────────────────────────────────────────────────────────────

/**
 * GET /debts  — list all debt accounts
 */
app.get("/debts", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("debt_accounts")
    .select("*")
    .eq("user_id", req.user.id)
    .eq("status", "active")
    .order("priority");

  if (error) return res.status(500).json({ error: "Failed to load debts." });
  res.json(data || []);
});

/**
 * POST /debts  — add a debt account
 */
app.post("/debts", requireAuth, async (req, res) => {
  const { name, balance, interest_rate, minimum_payment, priority } = req.body;

  if (!name || !balance) return res.status(400).json({ error: "Name and balance are required." });

  const { data, error } = await supabase
    .from("debt_accounts")
    .insert({ user_id: req.user.id, name, balance, original_balance: balance, interest_rate: interest_rate || 0, minimum_payment: minimum_payment || 0, priority: priority || 1 })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "Failed to add debt." });
  res.status(201).json(data);
});

/**
 * PATCH /debts/:id  — update balance after payment
 */
app.patch("/debts/:id", requireAuth, async (req, res) => {
  const { balance, status } = req.body;

  const { data, error } = await supabase
    .from("debt_accounts")
    .update({ balance, status, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .eq("user_id", req.user.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: "Failed to update debt." });
  res.json(data);
});

// ── WEEKLY CHECK-IN ───────────────────────────────────────────────────────────

/**
 * POST /checkin  — save this week's check-in
 */
app.post("/checkin", requireAuth, async (req, res) => {
  const { items, notes } = req.body;

  // Get Monday of current week
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const week_of = monday.toISOString().split("T")[0];

  const score = (items || []).filter(i => i.done).length;

  const { data, error } = await supabase
    .from("checkins")
    .upsert({ user_id: req.user.id, week_of, items: items || [], score, notes }, { onConflict: "user_id,week_of" })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "Failed to save check-in." });
  res.json({ success: true, checkin: data });
});

/**
 * GET /checkin  — get this week's check-in
 */
app.get("/checkin", requireAuth, async (req, res) => {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const week_of = monday.toISOString().split("T")[0];

  const { data } = await supabase
    .from("checkins")
    .select("*")
    .eq("user_id", req.user.id)
    .eq("week_of", week_of)
    .single();

  res.json(data || null);
});

// ── CHAT HISTORY ──────────────────────────────────────────────────────────────

/**
 * GET /chat/history  — load recent chat messages (last 50)
 */
app.get("/chat/history", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("chat_history")
    .select("role, content, created_at")
    .eq("user_id", req.user.id)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) return res.status(500).json({ error: "Failed to load chat history." });
  res.json(data || []);
});

// ── AI ENDPOINTS ──────────────────────────────────────────────────────────────

/**
 * POST /ai/chat  — AI Coach with persistent chat history
 */
app.post("/ai/chat", requireAuth, aiLimiter, async (req, res) => {
  const { messages, context } = req.body;

  if (!messages?.length) return res.status(400).json({ error: "messages array is required." });

  // Build enriched system prompt with user's plan context
  const plan = await getUserPlan(req.user.id);
  let systemPrompt = SYSTEM_PROMPT;
  if (plan) {
    systemPrompt += `\n\nUser's saved financial plan: Income $${plan.income}/mo, Expenses $${plan.expenses}/mo, Surplus $${plan.surplus}/mo, Debt $${plan.debt}, Savings $${plan.savings}. Goals: ${plan.goals}. Timeline: ${plan.timeline}.`;
  }
  if (context) systemPrompt += `\n\nAdditional context: ${context}`;

  // Call Anthropic
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: messages.map(m => ({ role: m.role, content: m.content })),
  });

  const reply = response.content?.[0]?.text || "I'm here to help!";

  // Persist the last user message + AI reply to chat history
  const lastUserMsg = messages[messages.length - 1];
  if (lastUserMsg?.role === "user") {
    await supabase.from("chat_history").insert([
      { user_id: req.user.id, role: "user", content: lastUserMsg.content },
      { user_id: req.user.id, role: "assistant", content: reply },
    ]);
  }

  console.log(`🤖  AI chat: ${req.user.email} (${messages.length} msgs)`);
  res.json({ reply, usage: response.usage });
});

/**
 * POST /ai/journal-insight
 */
app.post("/ai/journal-insight", requireAuth, aiLimiter, async (req, res) => {
  const { entry, mood, mood_label } = req.body;
  if (!entry?.trim()) return res.status(400).json({ error: "Entry is required." });

  const plan = await getUserPlan(req.user.id);
  const planCtx = plan ? `Income $${plan.income}/mo, Debt $${plan.debt}, Savings $${plan.savings}.` : "";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Financial journal entry. Mood: ${mood_label} ${mood}. Entry: "${entry}"\n${planCtx}\n\nBrief warm coaching insight (2-3 sentences) + one action.` }],
  });

  res.json({ insight: response.content?.[0]?.text });
});

/**
 * POST /ai/spending-analysis
 */
app.post("/ai/spending-analysis", requireAuth, aiLimiter, async (req, res) => {
  const { spending } = req.body;
  if (!spending?.length) return res.status(400).json({ error: "spending array is required." });

  const leaks = spending.filter(s => s.leak);
  const totalLeak = leaks.reduce((sum, s) => sum + (s.actual - s.budget), 0);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Spending leaks:\n${leaks.map(s => `- ${s.cat}: +$${s.actual - s.budget}/mo over budget`).join("\n")}\nTotal: $${totalLeak}/mo over.\n\nGive 2-3 warm, specific coaching recommendations. One faith-based stewardship perspective. Max 3 short paragraphs.` }],
  });

  res.json({ analysis: response.content?.[0]?.text });
});

// ── ACCOUNTABILITY PARTNERS ───────────────────────────────────────────────────

/**
 * POST /partners/invite  — invite someone by email to be your accountability partner
 */
app.post("/partners/invite", requireAuth, async (req, res) => {
  const { partner_email, shared_goal } = req.body;

  // Look up partner by email
  const { data: partnerProfile } = await supabase
    .from("profiles")
    .select("id, name, email")
    .eq("email", partner_email.toLowerCase())
    .single();

  if (!partnerProfile) {
    return res.status(404).json({ error: "No The Healed Place · Wealth account found for that email." });
  }

  const { data, error } = await supabase
    .from("accountability_partners")
    .insert({ user_id: req.user.id, partner_id: partnerProfile.id, shared_goal, status: "pending" })
    .select()
    .single();

  if (error) return res.status(500).json({ error: "Failed to send invite." });
  res.status(201).json({ success: true, partnership: data });
});

/**
 * GET /partners  — get current user's accountability partners
 */
app.get("/partners", requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from("accountability_partners")
    .select("*, profiles!accountability_partners_partner_id_fkey(name, email)")
    .eq("user_id", req.user.id)
    .eq("status", "active");

  if (error) return res.status(500).json({ error: "Failed to load partners." });
  res.json(data || []);
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getUserPlan(userId) {
  const { data } = await supabase
    .from("financial_plans")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .single();
  return data || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Something went wrong." });
});

app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n👑  The Healed Place · Wealth API (Supabase)`);
  console.log(`🚀  http://localhost:${PORT}`);
  console.log(`🗄️   Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`🤖  Anthropic: claude-sonnet-4-20250514`);
  console.log(`🛡️   Rate limiting: 10 AI calls/min\n`);
});

export default app;
