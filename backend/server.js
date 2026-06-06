import path from "path";
import express from "express";
import multer from "multer";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import Stripe from "stripe";
import pg from "pg";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    let value = trimmedLine.slice(separatorIndex + 1).trim();

    if (!key || process.env[key]) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, ".env"));

function normalizePostgresUrl(databaseUrl) {
  if (!databaseUrl) {
    return "";
  }

  try {
    const parsedUrl = new URL(databaseUrl);
    const sslMode = parsedUrl.searchParams.get("sslmode");

    if (["prefer", "require", "verify-ca"].includes(sslMode)) {
      parsedUrl.searchParams.set("sslmode", "verify-full");
    }

    return parsedUrl.toString();
  } catch {
    return databaseUrl.replace(
      /([?&]sslmode=)(prefer|require|verify-ca)(?=&|$)/i,
      "$1verify-full",
    );
  }
}

const app = express();
const PORT = Number(process.env.PORT || 3001);
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";
const FREE_MONTHLY_LIMIT = Number(process.env.FREE_MONTHLY_LIMIT || 5);
const PRO_MONTHLY_LIMIT = Number(process.env.PRO_MONTHLY_LIMIT || 60);
const SESSION_SECRET =
  process.env.SESSION_SECRET || "vendibot-se-quiser-aprender-aja";
const PASSWORD_RESET_CODE = process.env.PASSWORD_RESET_CODE || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const OPENAI_ENABLE_WEB_SEARCH = process.env.OPENAI_ENABLE_WEB_SEARCH !== "false";
const OPENAI_SEARCH_COUNTRY = (process.env.OPENAI_SEARCH_COUNTRY || "NL").toUpperCase();
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(
  /\/$/,
  "",
);
const DEFAULT_ALLOWED_ORIGINS = [
  APP_URL,
  "http://localhost:4173",
  "http://127.0.0.1:4173",
];
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(",")
)
  .split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);
const DATABASE_URL = normalizePostgresUrl(process.env.DATABASE_URL || "");
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const WISE_API_TOKEN = process.env.WISE_API_TOKEN || "";
const WISE_PROFILE_ID = process.env.WISE_PROFILE_ID || "";
const WISE_PAYMENT_LINK_URL = (process.env.WISE_PAYMENT_LINK_URL || "").trim();
const WISE_ACCOUNT_HOLDER = process.env.WISE_ACCOUNT_HOLDER || "";
const WISE_IBAN = process.env.WISE_IBAN || "";
const WISE_BIC = process.env.WISE_BIC || "";
const WISE_PAYMENT_NOTE =
  process.env.WISE_PAYMENT_NOTE ||
  "Use the reference exactly as shown so credits can be added automatically.";
const WISE_ENVIRONMENT = (process.env.WISE_ENVIRONMENT || "production").toLowerCase();
const WISE_API_BASE_URL =
  process.env.WISE_API_BASE_URL ||
  (WISE_ENVIRONMENT === "sandbox"
    ? "https://api.wise-sandbox.com"
    : "https://api.wise.com");
const BUNQ_ENVIRONMENT = (process.env.BUNQ_ENVIRONMENT || "production").toLowerCase();
const BUNQ_API_BASE_URL =
  (process.env.BUNQ_API_BASE_URL || "").replace(/\/$/, "") ||
  (BUNQ_ENVIRONMENT === "sandbox"
    ? "https://public-api.sandbox.bunq.com/v1"
    : "https://api.bunq.com/v1");
const BUNQ_API_KEY = process.env.BUNQ_API_KEY || "";
const BUNQ_USER_ID = process.env.BUNQ_USER_ID || "";
const BUNQ_ACCOUNT_ID = process.env.BUNQ_ACCOUNT_ID || "";
const BUNQ_SESSION_TOKEN =
  process.env.BUNQ_SESSION_TOKEN ||
  process.env.BUNQ_CLIENT_AUTHENTICATION ||
  "";
const BUNQ_PRIVATE_KEY = process.env.BUNQ_PRIVATE_KEY || "";
const BUNQ_PUBLIC_KEY = process.env.BUNQ_PUBLIC_KEY || "";
const BUNQ_DEVICE_DESCRIPTION =
  process.env.BUNQ_DEVICE_DESCRIPTION || "Vendibot Render server";
const BUNQ_PERMITTED_IPS = (process.env.BUNQ_PERMITTED_IPS || "")
  .split(",")
  .map((ip) => ip.trim())
  .filter(Boolean);
const BUNQ_WEBHOOK_SECRET = process.env.BUNQ_WEBHOOK_SECRET || "";
const BUNQ_PAYMENT_DESCRIPTION =
  process.env.BUNQ_PAYMENT_DESCRIPTION || "Vendibot credit package";
const BUNQ_GEOLOCATION = process.env.BUNQ_GEOLOCATION || "0 0 0 0 NL";
const BUNQ_LANGUAGE = process.env.BUNQ_LANGUAGE || "en_US";
const BUNQ_REGION = process.env.BUNQ_REGION || "en_US";

const CREDIT_PACKAGES = {
  credits_10: { key: "credits_10", credits: 10, amountCents: 300 },
  credits_30: { key: "credits_30", credits: 30, amountCents: 700 },
  credits_60: { key: "credits_60", credits: 60, amountCents: 900 },
};

const WISE_PRODUCTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvO8vXV+JksBzZAY6GhSO
XdoTCfhXaaiZ+qAbtaDBiu2AGkGVpmEygFmWP4Li9m5+Ni85BhVvZOodM9epgW3F
bA5Q1SexvAF1PPjX4JpMstak/QhAgl1qMSqEevL8cmUeTgcMuVWCJmlge9h7B1CS
D4rtlimGZozG39rUBDg6Qt2K+P4wBfLblL0k4C4YUdLnpGYEDIth+i8XsRpFlogx
CAFyH9+knYsDbR43UJ9shtc42Ybd40Afihj8KnYKXzchyQ42aC8aZ/h5hyZ28yVy
Oj3Vos0VdBIs/gAyJ/4yyQFCXYte64I7ssrlbGRaco4nKF3HmaNhxwyKyJafz19e
HwIDAQAB
-----END PUBLIC KEY-----`;

const WISE_SANDBOX_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwpb91cEYuyJNQepZAVfP
ZIlPZfNUefH+n6w9SW3fykqKu938cR7WadQv87oF2VuT+fDt7kqeRziTmPSUhqPU
ys/V2Q1rlfJuXbE+Gga37t7zwd0egQ+KyOEHQOpcTwKmtZ81ieGHynAQzsn1We3j
wt760MsCPJ7GMT141ByQM+yW1Bx+4SG3IGjXWyqOWrcXsxAvIXkpUD/jK/L958Cg
nZEgz0BSEh0QxYLITnW1lLokSx/dTianWPFEhMC9BgijempgNXHNfcVirg1lPSyg
z7KqoKUN0oHqWLr2U1A+7kqrl6O2nx3CKs1bj1hToT1+p4kcMoHXA7kA+VBLUpEs
VwIDAQAB
-----END PUBLIC KEY-----`;

if (!process.env.SESSION_SECRET) {
  console.warn("Aviso: defina SESSION_SECRET em producao.");
}

if (!process.env.OPENAI_API_KEY) {
  console.warn("Aviso: defina OPENAI_API_KEY para gerar anuncios.");
}

if (!PASSWORD_RESET_CODE) {
  console.warn("Aviso: defina PASSWORD_RESET_CODE para recuperar senhas.");
}

if (!WISE_PAYMENT_LINK_URL && (!WISE_ACCOUNT_HOLDER || !WISE_IBAN)) {
  console.warn(
    "Aviso: defina WISE_ACCOUNT_HOLDER e WISE_IBAN para mostrar instrucoes de pagamento.",
  );
}

if (!WISE_API_TOKEN || !WISE_PROFILE_ID) {
  console.warn("Aviso: defina WISE_API_TOKEN e WISE_PROFILE_ID para a Wise.");
}

if (!BUNQ_API_KEY && !BUNQ_SESSION_TOKEN) {
  console.warn("Aviso: defina BUNQ_API_KEY no Render para pagamentos bunq.");
}

if (!BUNQ_USER_ID || !BUNQ_ACCOUNT_ID) {
  console.warn("Aviso: defina BUNQ_USER_ID e BUNQ_ACCOUNT_ID no Render.");
}

if (IS_PRODUCTION && !DATABASE_URL) {
  throw new Error("DATABASE_URL e obrigatorio em producao.");
}

if (IS_PRODUCTION && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET e obrigatorio em producao.");
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl:
        process.env.DATABASE_SSL === "false"
          ? false
          : { rejectUnauthorized: false },
    })
  : null;

const dataDir = path.join(__dirname, "data");
const uploadsDir = path.join(__dirname, "uploads");
const usersPath = path.join(dataDir, "users.json");
const frontendDir = path.join(__dirname, "..", "frontend");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });

if (IS_PRODUCTION) {
  app.set("trust proxy", 1);
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin.replace(/\/$/, ""))) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    credentials: true,
  }),
);

app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) {
      res.status(500).json({ error: "Stripe nao configurado." });
      return;
    }

    let event;

    try {
      if (STRIPE_WEBHOOK_SECRET) {
        event = stripe.webhooks.constructEvent(
          req.body,
          req.headers["stripe-signature"],
          STRIPE_WEBHOOK_SECRET,
        );
      } else {
        event = JSON.parse(req.body.toString("utf8"));
      }
    } catch (err) {
      res.status(400).send(`Webhook invalido: ${err.message}`);
      return;
    }

    try {
      await handleStripeEvent(event);
      res.json({ received: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Falha ao processar webhook." });
    }
  },
);

app.post(
  "/billing/wise/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      await handleWiseWebhook(req);
      res.json({ received: true });
    } catch (err) {
      console.error("Falha ao processar webhook da Wise:", err);
      res.status(err.status || 400).json({
        error: err.message || "Webhook Wise invalido.",
      });
    }
  },
);

app.get("/billing/wise/webhook", (_req, res) => {
  res.json({ ok: true, webhook: "wise" });
});

app.post(
  "/billing/bunq/webhook",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      await handleBunqWebhook(req);
      res.json({ received: true });
    } catch (err) {
      console.error("Falha ao processar webhook do bunq:", err);
      res.status(err.status || 400).json({
        error: err.message || "Webhook bunq invalido.",
      });
    }
  },
);

app.get("/billing/bunq/webhook", (_req, res) => {
  res.json({ ok: true, webhook: "bunq" });
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(frontendDir));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/auth", authLimiter);

const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 12,
  },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype.startsWith("image/")) {
      callback(new Error("Envie apenas imagens."));
      return;
    }

    callback(null, true);
  },
});

function readUsersJson() {
  if (!fs.existsSync(usersPath)) {
    return [];
  }

  try {
    return JSON.parse(fs.readFileSync(usersPath, "utf8"));
  } catch {
    return [];
  }
}

function writeUsersJson(users) {
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 2));
}

function normalizeDbUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
    plan: row.plan,
    usage: {
      month: row.usage_month,
      generations: Number(row.usage_generations || 0),
    },
    analytics: {
      creditsUsed: Number(row.credits_used || 0),
      copyButtonClicks: Number(row.copy_button_clicks || 0),
      vintedRedirectClicks: Number(row.vinted_redirect_clicks || 0),
      paywallViews: Number(row.paywall_views || 0),
      checkoutAttempts: Number(row.checkout_attempts || 0),
    },
    creditsBalance: Number(row.credits_balance || 0),
    stripeCustomerId: row.stripe_customer_id || "",
    stripeSubscriptionId: row.stripe_subscription_id || "",
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    passwordChangedAt:
      row.password_changed_at instanceof Date
        ? row.password_changed_at.toISOString()
        : row.password_changed_at,
  };
}

async function initDataStore() {
  if (!pool) {
    return;
  }

  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      email text UNIQUE NOT NULL,
      password_salt text NOT NULL,
      password_hash text NOT NULL,
      plan text NOT NULL DEFAULT 'free',
      usage_month text NOT NULL,
      usage_generations integer NOT NULL DEFAULT 0,
      credits_balance integer NOT NULL DEFAULT 0,
      credits_used integer NOT NULL DEFAULT 0,
      copy_button_clicks integer NOT NULL DEFAULT 0,
      vinted_redirect_clicks integer NOT NULL DEFAULT 0,
      paywall_views integer NOT NULL DEFAULT 0,
      checkout_attempts integer NOT NULL DEFAULT 0,
      stripe_customer_id text,
      stripe_subscription_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      password_changed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS users_stripe_customer_id_idx
      ON users (stripe_customer_id);

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS credits_balance integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS credits_used integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS copy_button_clicks integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS vinted_redirect_clicks integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS paywall_views integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS checkout_attempts integer NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS wise_credit_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      package_key text NOT NULL,
      credits integer NOT NULL,
      amount_cents integer NOT NULL,
      currency text NOT NULL DEFAULT 'EUR',
      reference text UNIQUE NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      wise_transfer_id text,
      wise_delivery_id text,
      raw_event jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      paid_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS wise_credit_orders_user_id_created_at_idx
      ON wise_credit_orders (user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS wise_credit_orders_status_amount_idx
      ON wise_credit_orders (status, currency, amount_cents);

    CREATE TABLE IF NOT EXISTS wise_webhook_events (
      delivery_id text PRIMARY KEY,
      event_type text,
      processed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS bunq_credit_orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      package_key text NOT NULL,
      credits integer NOT NULL,
      amount_cents integer NOT NULL,
      currency text NOT NULL DEFAULT 'EUR',
      reference text UNIQUE NOT NULL,
      bunqme_tab_id text,
      payment_url text,
      status text NOT NULL DEFAULT 'pending',
      raw_response jsonb,
      raw_event jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      paid_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS bunq_credit_orders_user_id_created_at_idx
      ON bunq_credit_orders (user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS bunq_credit_orders_status_created_at_idx
      ON bunq_credit_orders (status, created_at DESC);

    CREATE INDEX IF NOT EXISTS bunq_credit_orders_bunqme_tab_id_idx
      ON bunq_credit_orders (bunqme_tab_id);

    CREATE TABLE IF NOT EXISTS bunq_webhook_events (
      delivery_id text PRIMARY KEY,
      event_type text,
      processed_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS anuncios (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      title text,
      suggested_price text,
      description text,
      highlights jsonb NOT NULL DEFAULT '[]'::jsonb,
      hashtags text[] NOT NULL DEFAULT ARRAY[]::text[],
      marketplace text,
      language text,
      source_description text,
      result text NOT NULL,
      image_count integer NOT NULL DEFAULT 0,
      model text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS anuncios_user_id_created_at_idx
      ON anuncios (user_id, created_at DESC);
  `);

  if (process.env.MIGRATE_JSON_USERS === "true") {
    await migrateJsonUsersToPostgres();
  }
}

async function migrateJsonUsersToPostgres() {
  const users = readUsersJson();

  for (const user of users) {
    normalizeUsage(user);

    await pool.query(
      `INSERT INTO users (
        id, name, email, password_salt, password_hash, plan, usage_month,
        usage_generations, stripe_customer_id, stripe_subscription_id,
        created_at, password_changed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (email) DO NOTHING`,
      [
        user.id,
        user.name || "Vendedor",
        user.email,
        user.passwordSalt,
        user.passwordHash,
        user.plan || "free",
        user.usage.month,
        user.usage.generations || 0,
        user.stripeCustomerId || null,
        user.stripeSubscriptionId || null,
        user.createdAt || new Date().toISOString(),
        user.passwordChangedAt || null,
      ],
    );
  }
}

async function getAllUsers() {
  if (!pool) {
    return readUsersJson();
  }

  const result = await pool.query("SELECT * FROM users ORDER BY created_at ASC");
  return result.rows.map(normalizeDbUser);
}

async function findUserByEmail(email) {
  if (!pool) {
    return readUsersJson().find((user) => user.email === email) || null;
  }

  const result = await pool.query("SELECT * FROM users WHERE email = $1", [
    email,
  ]);
  return result.rows[0] ? normalizeDbUser(result.rows[0]) : null;
}

async function findUserById(id) {
  if (!pool) {
    return readUsersJson().find((user) => user.id === id) || null;
  }

  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] ? normalizeDbUser(result.rows[0]) : null;
}

async function findUserByStripeCustomerId(customerId) {
  if (!customerId) {
    return null;
  }

  if (!pool) {
    return (
      readUsersJson().find((user) => user.stripeCustomerId === customerId) ||
      null
    );
  }

  const result = await pool.query(
    "SELECT * FROM users WHERE stripe_customer_id = $1",
    [customerId],
  );
  return result.rows[0] ? normalizeDbUser(result.rows[0]) : null;
}

async function createUser(user) {
  normalizeUsage(user);

  if (!pool) {
    const users = readUsersJson();
    users.push(user);
    writeUsersJson(users);
    return user;
  }

  await pool.query(
    `INSERT INTO users (
      id, name, email, password_salt, password_hash, plan, usage_month,
      usage_generations, stripe_customer_id, stripe_subscription_id, created_at,
      password_changed_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      user.id,
      user.name,
      user.email,
      user.passwordSalt,
      user.passwordHash,
      user.plan,
      user.usage.month,
      user.usage.generations,
      user.stripeCustomerId || null,
      user.stripeSubscriptionId || null,
      user.createdAt,
      user.passwordChangedAt || null,
    ],
  );

  return user;
}

async function updateUser(user) {
  normalizeUsage(user);

  if (!pool) {
    const users = readUsersJson();
    const index = users.findIndex((item) => item.id === user.id);

    if (index !== -1) {
      users[index] = user;
      writeUsersJson(users);
    }

    return user;
  }

  await pool.query(
    `UPDATE users
      SET name = $2,
          email = $3,
          password_salt = $4,
          password_hash = $5,
          plan = $6,
          usage_month = $7,
          usage_generations = $8,
          stripe_customer_id = $9,
          stripe_subscription_id = $10,
          password_changed_at = $11,
          credits_balance = $12,
          updated_at = now()
      WHERE id = $1`,
    [
      user.id,
      user.name,
      user.email,
      user.passwordSalt,
      user.passwordHash,
      user.plan,
      user.usage.month,
      user.usage.generations,
      user.stripeCustomerId || null,
      user.stripeSubscriptionId || null,
      user.passwordChangedAt || null,
      Number(user.creditsBalance || 0),
    ],
  );

  return user;
}

function parseListingField(result, labels) {
  const lines = String(result || "").split(/\r?\n/);

  for (const line of lines) {
    for (const label of labels) {
      const prefix = `${label}:`;

      if (line.toLowerCase().startsWith(prefix.toLowerCase())) {
        return cleanListingField(line.slice(prefix.length));
      }
    }
  }

  return "";
}

function normalizeListingLabel(value) {
  return String(value || "")
    .trim()
    .replace(/:$/, "")
    .toLowerCase();
}

function cleanListingField(value) {
  const cleaned = String(value || "").trim();
  const normalized = cleaned.toLowerCase();
  const emptyValues = new Set([
    "-",
    "--",
    "n/a",
    "na",
    "n.d.",
    "n.d",
    "none",
    "null",
    "undefined",
  ]);

  if (!cleaned || emptyValues.has(normalized) || /^[-–—]+$/.test(cleaned)) {
    return "";
  }

  return cleaned;
}

function parseListingBlock(result, startLabels, stopLabels = []) {
  const lines = String(result || "").split(/\r?\n/);
  const startSet = new Set(startLabels.map(normalizeListingLabel));
  const stopSet = new Set(stopLabels.map(normalizeListingLabel));
  const output = [];
  let isCollecting = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const labelMatch = trimmedLine.match(/^([^:]{2,80}):\s*(.*)$/);
    const label = labelMatch ? normalizeListingLabel(labelMatch[1]) : "";

    if (label && startSet.has(label)) {
      isCollecting = true;

      if (labelMatch[2]) {
        output.push(labelMatch[2].trim());
      }

      continue;
    }

    if (isCollecting && label && stopSet.has(label)) {
      break;
    }

    if (isCollecting) {
      output.push(line);
    }
  }

  return output.join("\n").trim();
}

function parseListingList(result, startLabels, stopLabels = []) {
  return parseListingBlock(result, startLabels, stopLabels)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
}

const titleLabels = ["Title", "Titulo", "Titel", "Titre", "Titolo"];
const priceLabels = [
  "Suggested resale price",
  "Used-market suggested price",
  "Market suggested price",
  "Suggested price",
  "Preco de mercado sugerido",
  "Preco sugerido",
  "Prijsadvies tweedehands",
  "Adviesprijs",
  "Precio sugerido de segunda mano",
  "Precio sugerido",
  "Prix conseille d'occasion",
  "Prix conseillé d'occasion",
  "Prix suggere",
  "Prezzo usato suggerito",
  "Prezzo suggerito",
];
const descriptionLabels = [
  "Description",
  "Descricao",
  "Beschrijving",
  "Descripcion",
  "Descrizione",
];
const highlightsLabels = [
  "Highlights",
  "Destaques",
  "Points forts",
  "Destacados",
  "Punti forti",
];
const hashtagsLabels = ["Hashtags"];
const allListingSectionLabels = [
  ...titleLabels,
  ...priceLabels,
  ...descriptionLabels,
  ...highlightsLabels,
  ...hashtagsLabels,
];

function safeListing(listing) {
  const description =
    listing.description ||
    parseListingBlock(listing.result, descriptionLabels, [
      ...highlightsLabels,
      ...hashtagsLabels,
    ]);
  const title = cleanListingField(listing.title);
  const suggestedPrice = cleanListingField(listing.suggestedPrice);

  return {
    id: listing.id,
    title: title || parseListingField(listing.result, titleLabels),
    suggestedPrice,
    description,
    highlights:
      listing.highlights?.length
        ? listing.highlights
        : parseListingList(listing.result, highlightsLabels, hashtagsLabels),
    hashtags:
      listing.hashtags?.length
        ? listing.hashtags
        : parseListingBlock(listing.result, hashtagsLabels, allListingSectionLabels)
            .split(/\s+/)
            .filter((item) => item.startsWith("#")),
    marketplace: listing.marketplace || "",
    language: listing.language || "",
    sourceDescription: listing.sourceDescription || "",
    result: listing.result || "",
    createdAt: listing.createdAt,
  };
}

async function createListingRecord(user, listing) {
  const parsedDescription =
    listing.description ||
    parseListingBlock(listing.result, descriptionLabels, [
      ...highlightsLabels,
      ...hashtagsLabels,
    ]);
  const title =
    cleanListingField(listing.title) ||
    parseListingField(listing.result, titleLabels);
  const suggestedPrice =
    cleanListingField(listing.suggestedPrice) ||
    parseListingField(listing.result, priceLabels);

  const record = {
    id: crypto.randomUUID(),
    userId: user.id,
    title,
    suggestedPrice,
    description: parsedDescription,
    highlights:
      listing.highlights?.length
        ? listing.highlights
        : parseListingList(listing.result, highlightsLabels, hashtagsLabels),
    hashtags:
      listing.hashtags?.length
        ? listing.hashtags
        : parseListingBlock(listing.result, hashtagsLabels, allListingSectionLabels)
            .split(/\s+/)
            .filter((item) => item.startsWith("#")),
    marketplace: listing.marketplace || "",
    language: listing.language || "",
    sourceDescription: listing.sourceDescription || "",
    result: listing.result || "",
    imageCount: Number(listing.imageCount || 0),
    model: listing.model || OPENAI_MODEL,
    createdAt: new Date().toISOString(),
  };

  if (!pool) {
    user.listings = [record, ...(user.listings || [])].slice(0, 50);
    await updateUser(user);
    return record;
  }

  await pool.query(
    `INSERT INTO anuncios (
      id, user_id, title, suggested_price, description, highlights, hashtags,
      marketplace, language, source_description, result, image_count, model,
      created_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6::jsonb, $7::text[], $8, $9, $10, $11, $12, $13, $14
    )`,
    [
      record.id,
      record.userId,
      record.title,
      record.suggestedPrice,
      record.description,
      JSON.stringify(record.highlights),
      record.hashtags,
      record.marketplace,
      record.language,
      record.sourceDescription,
      record.result,
      record.imageCount,
      record.model,
      record.createdAt,
    ],
  );

  return record;
}

async function listUserListings(user, limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit || 10)));

  if (!pool) {
    return (user.listings || []).slice(0, safeLimit).map(safeListing);
  }

  const result = await pool.query(
    `SELECT
      id,
      title,
      suggested_price AS "suggestedPrice",
      marketplace,
      language,
      result,
      created_at AS "createdAt"
    FROM anuncios
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT $2`,
    [user.id, safeLimit],
  );

  return result.rows.map(safeListing);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto
    .pbkdf2Sync(password, salt, 120000, 32, "sha256")
    .toString("hex");

  return { salt, hash };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.passwordSalt);
  return crypto.timingSafeEqual(
    Buffer.from(hash, "hex"),
    Buffer.from(user.passwordHash, "hex"),
  );
}

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

function signToken(payloadPart) {
  return crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(payloadPart)
    .digest("base64url");
}

function createToken(user) {
  const payload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    plan: user.plan,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  const payloadPart = base64Url(JSON.stringify(payload));
  return `${payloadPart}.${signToken(payloadPart)}`;
}

function verifyToken(token) {
  if (!token || !token.includes(".")) {
    return null;
  }

  const [payloadPart, signature] = token.split(".");
  const expectedSignature = signToken(payloadPart);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString());
    if (payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

function safeUser(user) {
  const limit = user.plan === "pro" ? PRO_MONTHLY_LIMIT : FREE_MONTHLY_LIMIT;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    plan: user.plan,
    usage: normalizeUsage(user),
    limit,
    creditsBalance: Number(user.creditsBalance || 0),
    analytics: normalizeAnalytics(user),
  };
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function normalizeUsage(user) {
  if (!user.usage || user.usage.month !== currentMonth()) {
    user.usage = { month: currentMonth(), generations: 0 };
  }

  return user.usage;
}

function normalizeAnalytics(user) {
  user.analytics = {
    creditsUsed: Number(user.analytics?.creditsUsed || user.creditsUsed || 0),
    copyButtonClicks: Number(
      user.analytics?.copyButtonClicks || user.copyButtonClicks || 0,
    ),
    vintedRedirectClicks: Number(
      user.analytics?.vintedRedirectClicks || user.vintedRedirectClicks || 0,
    ),
    paywallViews: Number(user.analytics?.paywallViews || user.paywallViews || 0),
    checkoutAttempts: Number(
      user.analytics?.checkoutAttempts || user.checkoutAttempts || 0,
    ),
  };

  return user.analytics;
}

const analyticsEvents = {
  generation_success: "credits_used",
  copy_button_click: "copy_button_clicks",
  vinted_redirect_click: "vinted_redirect_clicks",
  paywall_view: "paywall_views",
  checkout_attempt: "checkout_attempts",
};

const analyticsColumnToKey = {
  credits_used: "creditsUsed",
  copy_button_clicks: "copyButtonClicks",
  vinted_redirect_clicks: "vintedRedirectClicks",
  paywall_views: "paywallViews",
  checkout_attempts: "checkoutAttempts",
};

async function incrementUserAnalytics(user, eventName) {
  const column = analyticsEvents[eventName];

  if (!column) {
    return null;
  }

  const analyticsKey = analyticsColumnToKey[column];

  if (!pool) {
    const analytics = normalizeAnalytics(user);
    analytics[analyticsKey] += 1;
    await updateUser(user);
    return analytics;
  }

  const result = await pool.query(
    `UPDATE users
      SET ${column} = ${column} + 1,
          updated_at = now()
      WHERE id = $1
      RETURNING
        credits_used,
        copy_button_clicks,
        vinted_redirect_clicks,
        paywall_views,
        checkout_attempts`,
    [user.id],
  );

  if (!result.rows[0]) {
    return null;
  }

  user.analytics = {
    creditsUsed: Number(result.rows[0].credits_used || 0),
    copyButtonClicks: Number(result.rows[0].copy_button_clicks || 0),
    vintedRedirectClicks: Number(result.rows[0].vinted_redirect_clicks || 0),
    paywallViews: Number(result.rows[0].paywall_views || 0),
    checkoutAttempts: Number(result.rows[0].checkout_attempts || 0),
  };

  return user.analytics;
}

function getWisePublicKey() {
  return WISE_ENVIRONMENT === "sandbox"
    ? WISE_SANDBOX_PUBLIC_KEY
    : WISE_PRODUCTION_PUBLIC_KEY;
}

function verifyWiseWebhookSignature(req) {
  if (process.env.WISE_WEBHOOK_VERIFY === "false") {
    return true;
  }

  const signature =
    req.headers["x-signature-sha256"] ||
    req.headers["x-signature"] ||
    req.headers["x-wise-signature-sha256"] ||
    req.headers["x-test-notification-signature"];

  if (!signature) {
    const err = new Error("Assinatura Wise ausente.");
    err.status = 401;
    throw err;
  }

  const normalizedSignature = String(signature).replace(/^sha256=/i, "");
  const isValid = crypto.verify(
    "RSA-SHA256",
    req.body,
    getWisePublicKey(),
    Buffer.from(normalizedSignature, "base64"),
  );

  if (!isValid) {
    const err = new Error("Assinatura Wise invalida.");
    err.status = 401;
    throw err;
  }

  return true;
}

function createWisePaymentUrl(order) {
  if (!WISE_PAYMENT_LINK_URL) {
    return "";
  }

  try {
    const url = new URL(WISE_PAYMENT_LINK_URL);
    url.searchParams.set("reference", order.reference);
    url.searchParams.set("amount", (order.amountCents / 100).toFixed(2));
    url.searchParams.set("currency", order.currency);
    return url.toString();
  } catch {
    return WISE_PAYMENT_LINK_URL;
  }
}

function generateWiseReference() {
  return `VENDIBOT-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

let bunqRuntimeContext = null;

function formatAmountCents(amountCents) {
  return (Number(amountCents || 0) / 100).toFixed(2);
}

function generateBunqReference() {
  return `VENDIBOT-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

function normalizePem(value) {
  return String(value || "").replace(/\\n/g, "\n").trim();
}

function createBunqKeyPair() {
  if (BUNQ_PRIVATE_KEY) {
    const privateKey = normalizePem(BUNQ_PRIVATE_KEY);
    const publicKey = BUNQ_PUBLIC_KEY
      ? normalizePem(BUNQ_PUBLIC_KEY)
      : crypto
          .createPublicKey(privateKey)
          .export({ type: "spki", format: "pem" });

    return { privateKey, publicKey };
  }

  const keyPair = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  return keyPair;
}

function signBunqPayload(payload, privateKey) {
  return crypto
    .sign("sha256", Buffer.from(payload), {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    })
    .toString("base64");
}

function flattenStrings(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }

  if (typeof value === "string" || typeof value === "number") {
    output.push(String(value));
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => flattenStrings(item, output));
    return output;
  }

  if (typeof value === "object") {
    Object.values(value).forEach((item) => flattenStrings(item, output));
  }

  return output;
}

function findBunqKey(value, key) {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBunqKey(item, key);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return value[key];
    }

    for (const item of Object.values(value)) {
      const found = findBunqKey(item, key);

      if (found !== undefined) {
        return found;
      }
    }
  }

  return undefined;
}

function collectBunqKey(value, key, output = []) {
  if (value === null || value === undefined) {
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectBunqKey(item, key, output));
    return output;
  }

  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      output.push(value[key]);
    }

    Object.values(value).forEach((item) => collectBunqKey(item, key, output));
  }

  return output;
}

function getBunqToken(response) {
  const token = findBunqKey(response, "Token");
  return String(token?.token || token || "");
}

function getBunqCreatedId(response) {
  const idWrapper = findBunqKey(response, "Id");
  const id = idWrapper?.id || findBunqKey(response, "id");
  return id === undefined || id === null ? "" : String(id);
}

function getBunqSessionUserId(response) {
  return String(
    findBunqKey(response, "UserPerson")?.id ||
      findBunqKey(response, "UserCompany")?.id ||
      findBunqKey(response, "UserPaymentServiceProvider")?.id ||
      findBunqKey(response, "UserApiKey")?.id ||
      "",
  );
}

function getBunqPaymentUrl(response) {
  const preferredKeys = [
    "bunqme_tab_share_url",
    "bunqme_tab_url",
    "bunqme_share_url",
    "share_url",
    "url",
  ];

  for (const key of preferredKeys) {
    const value = findBunqKey(response, key);

    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      return value;
    }
  }

  return (
    flattenStrings(response).find((value) =>
      /^https?:\/\/(www\.)?bunq\.me\//i.test(value),
    ) || ""
  );
}

function getBunqErrorMessage(response) {
  const errors = collectBunqKey(response, "Error");
  const descriptions = errors
    .flatMap((error) => (Array.isArray(error) ? error : [error]))
    .map((error) => error?.error_description || error?.description || error)
    .filter(Boolean);

  return descriptions.join(" ") || "Falha na comunicacao com o bunq.";
}

async function bunqFetch(pathname, options = {}) {
  const method = options.method || "GET";
  const bodyText =
    options.body === undefined ? "" : JSON.stringify(options.body);
  const headers = {
    Accept: "application/json",
    "Cache-Control": "no-cache",
    "User-Agent": "Vendibot/1.0",
    "X-Bunq-Language": BUNQ_LANGUAGE,
    "X-Bunq-Region": BUNQ_REGION,
    "X-Bunq-Geolocation": BUNQ_GEOLOCATION,
    "X-Bunq-Client-Request-Id": crypto.randomUUID(),
    ...(options.headers || {}),
  };

  if (bodyText) {
    headers["Content-Type"] = "application/json";
  }

  if (options.authToken) {
    headers["X-Bunq-Client-Authentication"] = options.authToken;
  }

  if (bodyText && options.privateKey && options.signed !== false) {
    headers["X-Bunq-Client-Signature"] = signBunqPayload(
      bodyText,
      options.privateKey,
    );
  }

  const response = await fetch(`${BUNQ_API_BASE_URL}${pathname}`, {
    method,
    headers,
    body: bodyText || undefined,
  });

  const responseText = await response.text();
  const data = responseText ? JSON.parse(responseText) : {};

  if (!response.ok) {
    const err = new Error(getBunqErrorMessage(data));
    err.status = response.status;
    err.response = data;
    throw err;
  }

  return data;
}

async function ensureBunqSession() {
  if (bunqRuntimeContext?.sessionToken) {
    return bunqRuntimeContext;
  }

  const keyPair = createBunqKeyPair();

  if (BUNQ_SESSION_TOKEN) {
    if (!BUNQ_PRIVATE_KEY) {
      const err = new Error(
        "Configure BUNQ_PRIVATE_KEY junto com BUNQ_SESSION_TOKEN, ou use apenas BUNQ_API_KEY.",
      );
      err.status = 500;
      throw err;
    }

    bunqRuntimeContext = {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      sessionToken: BUNQ_SESSION_TOKEN,
      userId: BUNQ_USER_ID,
    };
    return bunqRuntimeContext;
  }

  if (!BUNQ_API_KEY) {
    const err = new Error("Configure BUNQ_API_KEY no Render.");
    err.status = 500;
    throw err;
  }

  const installation = await bunqFetch("/installation", {
    method: "POST",
    body: { client_public_key: keyPair.publicKey },
    signed: false,
  });
  const installationToken = getBunqToken(installation);

  if (!installationToken) {
    const err = new Error("O bunq nao retornou token de instalacao.");
    err.status = 502;
    throw err;
  }

  const deviceBody = {
    description: BUNQ_DEVICE_DESCRIPTION,
    secret: BUNQ_API_KEY,
  };

  if (BUNQ_PERMITTED_IPS.length) {
    deviceBody.permitted_ips = BUNQ_PERMITTED_IPS;
  }

  await bunqFetch("/device-server", {
    method: "POST",
    authToken: installationToken,
    privateKey: keyPair.privateKey,
    body: deviceBody,
  });

  const session = await bunqFetch("/session-server", {
    method: "POST",
    authToken: installationToken,
    privateKey: keyPair.privateKey,
    body: { secret: BUNQ_API_KEY },
  });
  const sessionToken = getBunqToken(session);

  if (!sessionToken) {
    const err = new Error("O bunq nao retornou token de sessao.");
    err.status = 502;
    throw err;
  }

  bunqRuntimeContext = {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    installationToken,
    sessionToken,
    userId: BUNQ_USER_ID || getBunqSessionUserId(session),
  };

  return bunqRuntimeContext;
}

async function bunqApi(pathname, options = {}) {
  const context = await ensureBunqSession();
  return bunqFetch(pathname, {
    ...options,
    authToken: context.sessionToken,
    privateKey: context.privateKey,
  });
}

function normalizeBunqOrder(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id || row.userId,
    packageKey: row.package_key || row.packageKey,
    credits: Number(row.credits || 0),
    amountCents: Number(row.amount_cents || row.amountCents || 0),
    currency: row.currency || "EUR",
    reference: row.reference || "",
    bunqmeTabId: row.bunqme_tab_id || row.bunqmeTabId || "",
    paymentUrl: row.payment_url || row.paymentUrl || "",
    status: row.status || "pending",
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    paidAt: row.paid_at instanceof Date ? row.paid_at.toISOString() : row.paid_at,
  };
}

function isBunqTabPaid(response) {
  const resultInquiries = [
    ...collectBunqKey(response, "BunqMeTabResultInquiry"),
    ...collectBunqKey(response, "bunqme_tab_result_inquiry"),
    ...collectBunqKey(response, "result_inquiries"),
  ].filter(Boolean);

  if (resultInquiries.length > 0) {
    return true;
  }

  const strings = flattenStrings(response).map((value) => value.toLowerCase());
  return strings.some((value) =>
    ["paid", "accepted", "completed", "settled", "succeeded"].includes(value),
  );
}

async function updateBunqOrderPaymentData(order, apiResponse, paymentUrl) {
  const bunqmeTabId = getBunqCreatedId(apiResponse) || order.bunqmeTabId;

  if (!pool) {
    order.bunqmeTabId = bunqmeTabId;
    order.paymentUrl = paymentUrl;
    return order;
  }

  const result = await pool.query(
    `UPDATE bunq_credit_orders
      SET bunqme_tab_id = $2,
          payment_url = $3,
          raw_response = $4,
          updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [order.id, bunqmeTabId, paymentUrl, JSON.stringify(apiResponse)],
  );

  return normalizeBunqOrder(result.rows[0]);
}

async function createBunqPaymentTab(order) {
  if (!BUNQ_ACCOUNT_ID) {
    const err = new Error("Configure BUNQ_ACCOUNT_ID no Render.");
    err.status = 500;
    throw err;
  }

  const context = await ensureBunqSession();
  const userId = BUNQ_USER_ID || context.userId;

  if (!userId) {
    const err = new Error("Configure BUNQ_USER_ID no Render.");
    err.status = 500;
    throw err;
  }

  const description = `${BUNQ_PAYMENT_DESCRIPTION} - ${order.credits} credits - ${order.reference}`;
  const route = `/user/${encodeURIComponent(userId)}/monetary-account/${encodeURIComponent(
    BUNQ_ACCOUNT_ID,
  )}/bunqme-tab`;
  const body = {
    bunqme_tab_entry: {
      amount_inquired: {
        value: formatAmountCents(order.amountCents),
        currency: order.currency,
      },
      description,
      redirect_url: `${APP_URL}/?bunq_order=${encodeURIComponent(order.id)}`,
    },
  };

  const createdTab = await bunqApi(route, {
    method: "POST",
    body,
  });
  const bunqmeTabId = getBunqCreatedId(createdTab);
  let tabResponse = createdTab;

  if (bunqmeTabId) {
    tabResponse = await bunqApi(`${route}/${encodeURIComponent(bunqmeTabId)}`);
  }

  const paymentUrl = getBunqPaymentUrl(tabResponse) || getBunqPaymentUrl(createdTab);

  if (!paymentUrl) {
    const err = new Error("O bunq criou o pedido, mas nao retornou o link de pagamento.");
    err.status = 502;
    throw err;
  }

  return updateBunqOrderPaymentData(
    { ...order, bunqmeTabId },
    { createdTab, tabResponse },
    paymentUrl,
  );
}

async function createBunqCreditOrder(user, packageKey) {
  const selectedPackage = CREDIT_PACKAGES[packageKey];

  if (!selectedPackage) {
    return null;
  }

  const order = {
    id: crypto.randomUUID(),
    userId: user.id,
    packageKey: selectedPackage.key,
    credits: selectedPackage.credits,
    amountCents: selectedPackage.amountCents,
    currency: "EUR",
    reference: generateBunqReference(),
    status: "pending",
    createdAt: new Date().toISOString(),
  };

  if (!pool) {
    user.bunqCreditOrders = [order, ...(user.bunqCreditOrders || [])];
    await updateUser(user);
    return createBunqPaymentTab(order);
  }

  const result = await pool.query(
    `INSERT INTO bunq_credit_orders (
      id, user_id, package_key, credits, amount_cents, currency, reference
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      order.id,
      order.userId,
      order.packageKey,
      order.credits,
      order.amountCents,
      order.currency,
      order.reference,
    ],
  );

  return createBunqPaymentTab(normalizeBunqOrder(result.rows[0]));
}

async function getBunqOrder(orderId, userId = "") {
  if (!pool) {
    const users = readUsersJson();
    const owner = users.find((user) =>
      (user.bunqCreditOrders || []).some((order) => order.id === orderId),
    );
    const order = owner?.bunqCreditOrders?.find((item) => item.id === orderId);

    if (!order || (userId && owner.id !== userId)) {
      return null;
    }

    return normalizeBunqOrder({ ...order, userId: owner.id });
  }

  const query = userId
    ? `SELECT * FROM bunq_credit_orders WHERE id = $1 AND user_id = $2`
    : `SELECT * FROM bunq_credit_orders WHERE id = $1`;
  const params = userId ? [orderId, userId] : [orderId];
  const result = await pool.query(query, params);
  return normalizeBunqOrder(result.rows[0]);
}

async function getPendingBunqOrders(limit = 20) {
  if (!pool) {
    return [];
  }

  const result = await pool.query(
    `SELECT * FROM bunq_credit_orders
      WHERE status = 'pending'
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );

  return result.rows.map(normalizeBunqOrder);
}

async function fetchBunqTab(order) {
  if (!order?.bunqmeTabId || !BUNQ_ACCOUNT_ID) {
    return null;
  }

  const context = await ensureBunqSession();
  const userId = BUNQ_USER_ID || context.userId;

  if (!userId) {
    return null;
  }

  return bunqApi(
    `/user/${encodeURIComponent(userId)}/monetary-account/${encodeURIComponent(
      BUNQ_ACCOUNT_ID,
    )}/bunqme-tab/${encodeURIComponent(order.bunqmeTabId)}`,
  );
}

async function creditBunqOrder(order, rawEvent) {
  if (!order || order.status === "paid") {
    return false;
  }

  if (!pool) {
    const users = readUsersJson();
    const user = users.find((item) => item.id === order.userId);

    if (!user) {
      return false;
    }

    const savedOrder = (user.bunqCreditOrders || []).find(
      (item) => item.id === order.id,
    );

    if (!savedOrder || savedOrder.status === "paid") {
      return false;
    }

    savedOrder.status = "paid";
    savedOrder.paidAt = new Date().toISOString();
    user.creditsBalance = Number(user.creditsBalance || 0) + order.credits;
    await updateUser(user);
    return true;
  }

  const result = await pool.query(
    `WITH paid_order AS (
      UPDATE bunq_credit_orders
      SET status = 'paid',
          raw_event = $2,
          paid_at = COALESCE(paid_at, now()),
          updated_at = now()
      WHERE id = $1 AND status <> 'paid'
      RETURNING user_id, credits
    )
    UPDATE users
    SET credits_balance = credits_balance + paid_order.credits,
        updated_at = now()
    FROM paid_order
    WHERE users.id = paid_order.user_id
    RETURNING users.id`,
    [order.id, JSON.stringify(rawEvent || {})],
  );

  return result.rowCount > 0;
}

async function checkAndCreditBunqOrder(order) {
  if (!order || order.status === "paid") {
    return order;
  }

  const tabResponse = await fetchBunqTab(order);

  if (!tabResponse || !isBunqTabPaid(tabResponse)) {
    return order;
  }

  await creditBunqOrder(order, tabResponse);
  return getBunqOrder(order.id);
}

async function reconcilePendingBunqOrders(limit = 20) {
  const pendingOrders = await getPendingBunqOrders(limit);

  for (const order of pendingOrders) {
    try {
      await checkAndCreditBunqOrder(order);
    } catch (err) {
      console.warn("Falha ao reconciliar pedido bunq:", err.message);
    }
  }
}

function parseRawJsonBody(req) {
  if (!req.body?.length) {
    return {};
  }

  try {
    return JSON.parse(req.body.toString("utf8"));
  } catch {
    return {};
  }
}

async function handleBunqWebhook(req) {
  const providedSecret = String(
    req.query?.secret ||
      req.headers["x-vendibot-webhook-secret"] ||
      req.headers["x-bunq-webhook-secret"] ||
      "",
  );

  if (BUNQ_WEBHOOK_SECRET && providedSecret !== BUNQ_WEBHOOK_SECRET) {
    const err = new Error("Webhook bunq nao autorizado.");
    err.status = 401;
    throw err;
  }

  const event = parseRawJsonBody(req);
  const deliveryId =
    String(
      req.headers["x-bunq-client-request-id"] ||
        req.headers["x-request-id"] ||
        findBunqKey(event, "id") ||
        "",
    ) || crypto.createHash("sha256").update(req.body || "").digest("hex");
  const eventType =
    String(findBunqKey(event, "notification_category") || findBunqKey(event, "type") || "") ||
    "bunq";

  if (pool) {
    const existingDelivery = await pool.query(
      "SELECT 1 FROM bunq_webhook_events WHERE delivery_id = $1",
      [deliveryId],
    );

    if (existingDelivery.rowCount > 0) {
      return;
    }

    await pool.query(
      `INSERT INTO bunq_webhook_events (delivery_id, event_type)
      VALUES ($1, $2)
      ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId, eventType],
    );
  }

  await reconcilePendingBunqOrders();
}

async function createWiseCreditOrder(user, packageKey) {
  const selectedPackage = CREDIT_PACKAGES[packageKey];

  if (!selectedPackage) {
    return null;
  }

  const order = {
    id: crypto.randomUUID(),
    userId: user.id,
    packageKey: selectedPackage.key,
    credits: selectedPackage.credits,
    amountCents: selectedPackage.amountCents,
    currency: "EUR",
    reference: generateWiseReference(),
    status: "pending",
    paymentUrl: "",
    createdAt: new Date().toISOString(),
  };

  if (!pool) {
    user.wiseCreditOrders = [order, ...(user.wiseCreditOrders || [])];
    await updateUser(user);
    order.paymentUrl = createWisePaymentUrl(order);
    return order;
  }

  const result = await pool.query(
    `INSERT INTO wise_credit_orders (
      id, user_id, package_key, credits, amount_cents, currency, reference
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id, user_id, package_key, credits, amount_cents, currency,
      reference, status, created_at`,
    [
      order.id,
      order.userId,
      order.packageKey,
      order.credits,
      order.amountCents,
      order.currency,
      order.reference,
    ],
  );

  const row = result.rows[0];
  const savedOrder = {
    id: row.id,
    userId: row.user_id,
    packageKey: row.package_key,
    credits: Number(row.credits),
    amountCents: Number(row.amount_cents),
    currency: row.currency,
    reference: row.reference,
    status: row.status,
    paymentUrl: "",
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
  savedOrder.paymentUrl = createWisePaymentUrl(savedOrder);

  return savedOrder;
}

function getWiseEventType(event) {
  return String(
    event?.event_type ||
      event?.eventType ||
      event?.subscription_type ||
      event?.type ||
      "",
  );
}

function getWiseDeliveryId(req, event) {
  return String(
    req.headers["x-delivery-id"] ||
      req.headers["x-wise-delivery-id"] ||
      event?.delivery_id ||
      event?.deliveryId ||
      event?.id ||
      crypto.createHash("sha256").update(req.body).digest("hex"),
  );
}

function flattenWiseStrings(value, output = []) {
  if (value === null || value === undefined) {
    return output;
  }

  if (typeof value === "string" || typeof value === "number") {
    output.push(String(value));
    return output;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => flattenWiseStrings(item, output));
    return output;
  }

  if (typeof value === "object") {
    Object.values(value).forEach((item) => flattenWiseStrings(item, output));
  }

  return output;
}

function extractWiseReference(event) {
  return (
    flattenWiseStrings(event)
      .find((value) => /VENDIBOT-[A-F0-9]{10}/i.test(value))
      ?.match(/VENDIBOT-[A-F0-9]{10}/i)?.[0]
      .toUpperCase() || ""
  );
}

function extractWiseAmountCents(event) {
  const candidates = [
    event?.amount,
    event?.data?.amount,
    event?.data?.resource?.amount,
    event?.resource?.amount,
    event?.resource?.details?.amount,
    event?.data?.current_state?.amount,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number") {
      return Math.round(candidate * 100);
    }

    if (typeof candidate?.value === "number") {
      return Math.round(candidate.value * 100);
    }

    if (typeof candidate?.amount === "number") {
      return Math.round(candidate.amount * 100);
    }
  }

  return 0;
}

function extractWiseCurrency(event) {
  return String(
    event?.currency ||
      event?.data?.currency ||
      event?.data?.resource?.currency ||
      event?.resource?.currency ||
      event?.resource?.details?.currency ||
      event?.data?.current_state?.currency ||
      "EUR",
  ).toUpperCase();
}

function extractWiseTransferId(event) {
  return String(
    event?.transfer_id ||
      event?.transferId ||
      event?.resource?.id ||
      event?.data?.resource?.id ||
      event?.data?.transfer_id ||
      "",
  );
}

async function findPendingWiseOrder({ reference, amountCents, currency }) {
  if (!pool) {
    return null;
  }

  if (reference) {
    const byReference = await pool.query(
      `SELECT * FROM wise_credit_orders
      WHERE reference = $1 AND status = 'pending'
      LIMIT 1`,
      [reference],
    );

    if (byReference.rows[0]) {
      return byReference.rows[0];
    }
  }

  if (!amountCents || !currency) {
    return null;
  }

  const byAmount = await pool.query(
    `SELECT * FROM wise_credit_orders
    WHERE status = 'pending'
      AND amount_cents = $1
      AND currency = $2
      AND created_at > now() - interval '14 days'
    ORDER BY created_at ASC
    LIMIT 2`,
    [amountCents, currency],
  );

  return byAmount.rowCount === 1 ? byAmount.rows[0] : null;
}

async function creditWiseOrder(order, event, deliveryId) {
  if (!pool || !order) {
    return false;
  }

  const transferId = extractWiseTransferId(event);

  const result = await pool.query(
    `WITH paid_order AS (
      UPDATE wise_credit_orders
      SET status = 'paid',
          wise_transfer_id = COALESCE($2, wise_transfer_id),
          wise_delivery_id = $3,
          raw_event = $4::jsonb,
          paid_at = now(),
          updated_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING user_id, credits
    )
    UPDATE users
    SET credits_balance = credits_balance + paid_order.credits,
        updated_at = now()
    FROM paid_order
    WHERE users.id = paid_order.user_id
    RETURNING users.id, users.credits_balance`,
    [
      order.id,
      transferId || null,
      deliveryId,
      JSON.stringify(event),
    ],
  );

  return result.rowCount > 0;
}

async function handleWiseWebhook(req) {
  verifyWiseWebhookSignature(req);

  const event = JSON.parse(req.body.toString("utf8"));
  const eventType = getWiseEventType(event);
  const deliveryId = getWiseDeliveryId(req, event);

  if (pool) {
    const existingDelivery = await pool.query(
      "SELECT 1 FROM wise_webhook_events WHERE delivery_id = $1",
      [deliveryId],
    );

    if (existingDelivery.rowCount > 0) {
      return;
    }

    await pool.query(
      `INSERT INTO wise_webhook_events (delivery_id, event_type)
      VALUES ($1, $2)
      ON CONFLICT (delivery_id) DO NOTHING`,
      [deliveryId, eventType],
    );
  }

  const lowerType = eventType.toLowerCase();
  const isPaymentApproved =
    lowerType.includes("balance") ||
    lowerType.includes("credit") ||
    lowerType.includes("account-details-payment") ||
    lowerType.includes("payment");

  if (!isPaymentApproved) {
    return;
  }

  const order = await findPendingWiseOrder({
    reference: extractWiseReference(event),
    amountCents: extractWiseAmountCents(event),
    currency: extractWiseCurrency(event),
  });

  if (!order) {
    console.warn("Webhook Wise recebido sem pedido pendente correspondente.");
    return;
  }

  await creditWiseOrder(order, event, deliveryId);
}

async function requireAuth(req, res, next) {
  try {
    const payload = verifyToken(getBearerToken(req));

    if (!payload) {
      res.status(401).json({ error: "Faca login para continuar." });
      return;
    }

    const user = await findUserById(payload.sub);

    if (!user) {
      res.status(401).json({ error: "Sessao invalida. Entre novamente." });
      return;
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function validateCredentials({ email, password }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const cleanPassword = String(password || "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return { error: "Informe um email valido." };
  }

  if (cleanPassword.length < 6) {
    return { error: "A senha precisa ter pelo menos 6 caracteres." };
  }

  return { email: normalizedEmail, password: cleanPassword };
}

async function handleStripeEvent(event) {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const userId = session.client_reference_id || session.metadata?.userId;
    const user = userId ? await findUserById(userId) : null;

    if (!user) {
      return;
    }

    user.plan = "pro";
    user.stripeCustomerId = String(session.customer || "");
    user.stripeSubscriptionId = String(session.subscription || "");
    await updateUser(user);
    return;
  }

  if (
    event.type === "customer.subscription.deleted" ||
    event.type === "customer.subscription.paused"
  ) {
    const subscription = event.data.object;
    const user = await findUserByStripeCustomerId(String(subscription.customer));

    if (!user) {
      return;
    }

    user.plan = "free";
    user.stripeSubscriptionId = "";
    await updateUser(user);
  }
}

app.get("/health", async (_req, res, next) => {
  try {
    if (pool) {
      await pool.query("SELECT 1");
    }

    res.json({
      ok: true,
      database: pool ? "postgres" : "json",
      payments: Boolean(stripe && STRIPE_PRICE_ID),
      wisePayments: Boolean(
        WISE_API_TOKEN &&
          WISE_PROFILE_ID &&
          (WISE_PAYMENT_LINK_URL || (WISE_ACCOUNT_HOLDER && WISE_IBAN)),
      ),
      bunqPayments: Boolean(
        (BUNQ_API_KEY || BUNQ_SESSION_TOKEN) && BUNQ_ACCOUNT_ID,
      ),
    });
  } catch (err) {
    next(err);
  }
});

app.post("/auth/register", async (req, res, next) => {
  try {
    const validation = validateCredentials(req.body);

    if (validation.error) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const existingUser = await findUserByEmail(validation.email);

    if (existingUser) {
      res.status(409).json({ error: "Este email ja esta cadastrado." });
      return;
    }

    const { salt, hash } = hashPassword(validation.password);
    const user = {
      id: crypto.randomUUID(),
      name: String(req.body.name || "Vendedor").trim().slice(0, 80),
      email: validation.email,
      passwordSalt: salt,
      passwordHash: hash,
      plan: "free",
      usage: { month: currentMonth(), generations: 0 },
      stripeCustomerId: "",
      stripeSubscriptionId: "",
      createdAt: new Date().toISOString(),
    };

    await createUser(user);

    res.status(201).json({
      token: createToken(user),
      user: safeUser(user),
    });
  } catch (err) {
    next(err);
  }
});

app.post("/auth/login", async (req, res, next) => {
  try {
    const validation = validateCredentials(req.body);

    if (validation.error) {
      res.status(400).json({ error: validation.error });
      return;
    }

    const user = await findUserByEmail(validation.email);

    if (!user || !verifyPassword(validation.password, user)) {
      res.status(401).json({ error: "Email ou senha incorretos." });
      return;
    }

    normalizeUsage(user);
    await updateUser(user);

    res.json({
      token: createToken(user),
      user: safeUser(user),
    });
  } catch (err) {
    next(err);
  }
});

app.post("/auth/reset-password", async (req, res, next) => {
  try {
    const validation = validateCredentials(req.body);

    if (validation.error) {
      res.status(400).json({ error: validation.error });
      return;
    }

    if (!PASSWORD_RESET_CODE) {
      res.status(500).json({
        error: "Configure PASSWORD_RESET_CODE no .env para trocar senhas.",
      });
      return;
    }

    if (String(req.body.resetCode || "").trim() !== PASSWORD_RESET_CODE) {
      res.status(403).json({ error: "Codigo de recuperacao incorreto." });
      return;
    }

    const user = await findUserByEmail(validation.email);

    if (!user) {
      res.status(404).json({ error: "Conta nao encontrada." });
      return;
    }

    const { salt, hash } = hashPassword(validation.password);
    user.passwordSalt = salt;
    user.passwordHash = hash;
    user.passwordChangedAt = new Date().toISOString();
    await updateUser(user);

    res.json({
      token: createToken(user),
      user: safeUser(user),
    });
  } catch (err) {
    next(err);
  }
});

app.get("/auth/me", requireAuth, async (req, res, next) => {
  try {
    normalizeUsage(req.user);
    await updateUser(req.user);
    res.json({ user: safeUser(req.user) });
  } catch (err) {
    next(err);
  }
});

app.get("/anuncios", requireAuth, async (req, res, next) => {
  try {
    const listings = await listUserListings(req.user, req.query.limit || 10);
    res.json({ listings });
  } catch (err) {
    next(err);
  }
});

app.post("/analytics/event", requireAuth, async (req, res, next) => {
  try {
    const analytics = await incrementUserAnalytics(
      req.user,
      String(req.body?.event || ""),
    );

    if (!analytics) {
      res.status(400).json({ error: "Evento de analytics invalido." });
      return;
    }

    res.json({ ok: true, analytics });
  } catch (err) {
    next(err);
  }
});

app.post("/billing/wise/create-payment-link", requireAuth, async (req, res, next) => {
  try {
    if (!WISE_API_TOKEN || !WISE_PROFILE_ID) {
      res.status(500).json({
        error: "Configure WISE_API_TOKEN e WISE_PROFILE_ID no backend.",
      });
      return;
    }

    if (!WISE_PAYMENT_LINK_URL && (!WISE_ACCOUNT_HOLDER || !WISE_IBAN)) {
      res.status(500).json({
        error:
          "Configure WISE_ACCOUNT_HOLDER e WISE_IBAN no backend.",
      });
      return;
    }

    const packageKey = String(req.body?.packageKey || "credits_10");
    const order = await createWiseCreditOrder(req.user, packageKey);

    if (!order) {
      res.status(400).json({ error: "Pacote de creditos invalido." });
      return;
    }

    await incrementUserAnalytics(req.user, "checkout_attempt");

    res.status(201).json({
      order,
      paymentUrl: order.paymentUrl,
      instructions: {
        amount: (order.amountCents / 100).toFixed(2),
        currency: order.currency,
        reference: order.reference,
        credits: order.credits,
        accountHolder: WISE_ACCOUNT_HOLDER,
        iban: WISE_IBAN,
        bic: WISE_BIC,
        note: WISE_PAYMENT_NOTE,
      },
    });
  } catch (err) {
    next(err);
  }
});

app.post("/billing/bunq/create-payment-link", requireAuth, async (req, res, next) => {
  try {
    if (!BUNQ_API_KEY && !BUNQ_SESSION_TOKEN) {
      res.status(500).json({
        error: "Configure BUNQ_API_KEY no Render.",
      });
      return;
    }

    if (!BUNQ_ACCOUNT_ID) {
      res.status(500).json({
        error: "Configure BUNQ_ACCOUNT_ID no Render.",
      });
      return;
    }

    const packageKey = String(req.body?.packageKey || "credits_10");
    const order = await createBunqCreditOrder(req.user, packageKey);

    if (!order) {
      res.status(400).json({ error: "Pacote de creditos invalido." });
      return;
    }

    await incrementUserAnalytics(req.user, "checkout_attempt");

    res.status(201).json({
      order,
      paymentUrl: order.paymentUrl,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/billing/bunq/order/:id", requireAuth, async (req, res, next) => {
  try {
    const order = await getBunqOrder(String(req.params.id || ""), req.user.id);

    if (!order) {
      res.status(404).json({ error: "Pedido de pagamento nao encontrado." });
      return;
    }

    const updatedOrder = await checkAndCreditBunqOrder(order);
    const updatedUser = await findUserById(req.user.id);

    res.json({
      order: updatedOrder,
      user: updatedUser ? safeUser(updatedUser) : safeUser(req.user),
    });
  } catch (err) {
    next(err);
  }
});

app.post("/billing/create-checkout-session", requireAuth, async (req, res, next) => {
  try {
    if (!stripe || !STRIPE_PRICE_ID) {
      res.status(500).json({
        error: "Configure STRIPE_SECRET_KEY e STRIPE_PRICE_ID no backend.",
      });
      return;
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      client_reference_id: req.user.id,
      customer_email: req.user.email,
      line_items: [
        {
          price: STRIPE_PRICE_ID,
          quantity: 1,
        },
      ],
      metadata: {
        userId: req.user.id,
      },
      subscription_data: {
        metadata: {
          userId: req.user.id,
        },
      },
      success_url: `${APP_URL}/?checkout=success`,
      cancel_url: `${APP_URL}/?checkout=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

const listingLanguageSettings = {
  pt: {
    name: "Brazilian Portuguese",
    currency: "Use EUR for Europe or R$ for Brazil when the context is clear.",
    format: `Titulo:
Preco de mercado sugerido:
Descricao:
Destaques:
- item
- item
- item

Hashtags:
#tag #tag #tag`,
  },
  en: {
    name: "English",
    currency: "Use EUR for Europe, USD for the United States, or GBP for the United Kingdom when the context is clear.",
    format: `Title:
Suggested resale price:
Description:
Highlights:
- item
- item
- item

Hashtags:
#tag #tag #tag`,
  },
  fr: {
    name: "French",
    currency: "Use EUR unless the context clearly indicates another currency.",
    format: `Titre:
Prix conseille d'occasion:
Description:
Points forts:
- item
- item
- item

Hashtags:
#tag #tag #tag`,
  },
  nl: {
    name: "Dutch",
    currency: "Use EUR unless the context clearly indicates another currency.",
    format: `Titel:
Prijsadvies tweedehands:
Beschrijving:
Highlights:
- item
- item
- item

Hashtags:
#tag #tag #tag`,
  },
  es: {
    name: "Spanish",
    currency: "Use EUR or a local currency when the context is clear.",
    format: `Titulo:
Precio sugerido de segunda mano:
Descripcion:
Destacados:
- item
- item
- item

Hashtags:
#tag #tag #tag`,
  },
  it: {
    name: "Italian",
    currency: "Use EUR unless the context clearly indicates another currency.",
    format: `Titolo:
Prezzo usato suggerito:
Descrizione:
Punti forti:
- item
- item
- item

Hashtags:
#tag #tag #tag`,
  },
};

function getListingLanguageSettings(language) {
  const code = String(language || "pt").slice(0, 2).toLowerCase();
  return listingLanguageSettings[code] || listingLanguageSettings.pt;
}

function isOpenAIWebSearchToolError(err) {
  const text = [
    err?.message,
    err?.error?.message,
    err?.response?.data,
    err?.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return text.includes("web_search") || text.includes("tool");
}

async function createListingResponse(input) {
  const request = {
    model: OPENAI_MODEL,
    input,
  };

  if (OPENAI_ENABLE_WEB_SEARCH) {
    request.tools = [
      {
        type: "web_search",
        search_context_size: "low",
        user_location: {
          type: "approximate",
          country: OPENAI_SEARCH_COUNTRY,
        },
      },
    ];
    request.tool_choice = "required";
  }

  try {
    return await openai.responses.create(request);
  } catch (err) {
    if (OPENAI_ENABLE_WEB_SEARCH && isOpenAIWebSearchToolError(err)) {
      console.warn(
        "OpenAI web search indisponivel; gerando anuncio sem busca web.",
      );
      return openai.responses.create({
        model: OPENAI_MODEL,
        input,
      });
    }

    throw err;
  }
}

app.post(
  "/generate",
  requireAuth,
  generateLimiter,
  upload.array("images", 12),
  async (req, res) => {
    try {
      const { description, lang, marketplace } = req.body;
      const cleanDescription = String(description || "").trim();
      const cleanMarketplace = String(marketplace || "").trim().slice(0, 80);
      const languageSettings = getListingLanguageSettings(lang);

      if (!cleanDescription && (!req.files || req.files.length === 0)) {
        res.status(400).json({ error: "Envie uma foto ou descreva o produto." });
        return;
      }

      if (!openai) {
        res.status(500).json({
          error: "Configure OPENAI_API_KEY no backend antes de gerar anuncios.",
        });
        return;
      }

      const usage = normalizeUsage(req.user);

      const monthlyLimit =
        req.user.plan === "pro" ? PRO_MONTHLY_LIMIT : FREE_MONTHLY_LIMIT;
      const hasFreeAllowance = !monthlyLimit || usage.generations < monthlyLimit;
      const hasPaidCredits = Number(req.user.creditsBalance || 0) > 0;

      if (!hasFreeAllowance && !hasPaidCredits) {
        res.status(402).json({
          error:
            "Limite mensal atingido. Compre creditos para continuar.",
        });
        return;
      }

      const content = [];

      if (cleanDescription) {
        content.push({
          type: "input_text",
          text: `Seller description: ${cleanDescription}`,
        });
      }

      if (cleanMarketplace) {
        content.push({
          type: "input_text",
          text: `Requested marketplace/channel: ${cleanMarketplace}`,
        });
      }

      for (const file of req.files || []) {
        const imageBase64 = fs.readFileSync(file.path, "base64");

        content.push({
          type: "input_image",
          image_url: `data:${file.mimetype};base64,${imageBase64}`,
        });
      }

      content.push({
        type: "input_text",
        text: `
You are an expert marketplace listing writer for Marktplaats, Vinted, Facebook Marketplace, OLX, and local marketplaces.

Create a natural, human, persuasive product listing based on the images and seller description.

Rules:
- Return only the final listing.
- Do not chat with the user.
- Do not say "sure", "here it is", or any assistant-like intro.
- Inspect uploaded images carefully for visible brand names, logos, labels, tags, model names, size labels, material tags, condition, and distinctive design details.
- Use the seller description as context only. Do not copy the seller description as the title.
- Rewrite the marketplace title from the identified product type, visible brand/model when confident, condition, size, color, and strongest selling detail.
- If the brand/model is visible in the image, use it in the title and price research. If it is uncertain, do not make a brand claim.
- Do not invent details that are not visible, provided, or found in web search results.
- Use natural, modern, direct wording.
- Highlight real benefits and the apparent condition of the product.
- Keep the title, suggested price, description, highlights, and hashtags clearly separated.
- Always include a short marketplace title after the title label.
- Treat used-market pricing as a primary task, not an optional detail.
- When web search is available, search for comparable used/resale prices using the visible brand/model/product type plus the requested marketplace/channel when possible.
- Estimate price from comparable secondhand-market behavior for similar brand, category, model, size, age, visible condition, seasonality, and the requested marketplace/channel.
- Prefer realistic resale prices for Vinted, Marktplaats, OLX, Facebook Marketplace, and local European marketplaces. Do not use new-retail pricing unless it helps anchor the used value.
- The suggested price line must start with one exact asking price that is easy to paste into a marketplace price field, for example "EUR 18" or "€18".
- After the exact asking price, add a short resale-market note when useful, for example "market range €15-22, quick sale €14". Keep it on the same line.
- If web search does not find a clear comparable or information is limited, still estimate a conservative used-market range from the visible category and condition instead of leaving the price blank.
- Do not claim a live search was performed unless web search results were actually available.
- For luxury, collectible, electronics, or authenticity-sensitive products, be conservative and mention uncertainty briefly in the suggested price line.
- Do not repeat the title or suggested price inside the Description section.
- Make the Description section ready to paste into the marketplace description field.
- Mandatory output language: ${languageSettings.name}.
- Translate every section label and every sentence into ${languageSettings.name}, even if the seller description or marketplace name is in another language.
- ${languageSettings.currency}

Mandatory format:

${languageSettings.format}

Do not skip any of those labels.
`,
      });

      const response = await createListingResponse([
        {
          role: "user",
          content,
        },
      ]);

      if (hasFreeAllowance) {
        usage.generations += 1;
      } else {
        req.user.creditsBalance = Math.max(0, Number(req.user.creditsBalance || 0) - 1);
      }

      await updateUser(req.user);
      await incrementUserAnalytics(req.user, "generation_success");
      const listing = await createListingRecord(req.user, {
        result: response.output_text,
        marketplace: cleanMarketplace,
        language: String(lang || "pt").slice(0, 8),
        sourceDescription: cleanDescription,
        imageCount: (req.files || []).length,
        model: OPENAI_MODEL,
      });

      res.json({
        result: response.output_text,
        listing: safeListing(listing),
        user: safeUser(req.user),
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Erro ao gerar o anuncio." });
    } finally {
      for (const file of req.files || []) {
        fs.rm(file.path, { force: true }, () => {});
      }
    }
  },
);

app.get("/admin/analytics", requireAuth, async (req, res, next) => {
  try {
    if (process.env.ADMIN_EMAIL !== req.user.email) {
      res.status(403).json({ error: "Acesso negado." });
      return;
    }

    const users = await getAllUsers();
    const summary = users.map((user) => {
      const analytics = normalizeAnalytics(user);

      return {
        id: user.id,
        email: user.email,
        creditsBalance: Number(user.creditsBalance || 0),
        creditsUsed: analytics.creditsUsed,
        creditsUsedLabel: `${analytics.creditsUsed} / ${FREE_MONTHLY_LIMIT}`,
        timesCopied: analytics.copyButtonClicks,
        vintedRedirectClicks: analytics.vintedRedirectClicks,
        redirectedToVinted: analytics.vintedRedirectClicks > 0,
        paywallViews: analytics.paywallViews,
        sawPaywall: analytics.paywallViews > 0,
        checkoutAttempts: analytics.checkoutAttempts,
        attemptedToPay: analytics.checkoutAttempts > 0,
      };
    });

    res.json({ users: summary });
  } catch (err) {
    next(err);
  }
});

app.get("/admin/users", requireAuth, async (req, res, next) => {
  try {
    if (process.env.ADMIN_EMAIL !== req.user.email) {
      res.status(403).json({ error: "Acesso negado." });
      return;
    }

    const users = await getAllUsers();
    res.json({ users: users.map(safeUser) });
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || "Requisicao invalida." });
});

initDataStore()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Vendibot backend rodando em http://localhost:${PORT}`);
      console.log(`Persistencia: ${pool ? "Postgres" : "JSON local"}`);
    });
  })
  .catch((err) => {
    console.error("Falha ao iniciar banco de dados:", err);
    process.exit(1);
  });
