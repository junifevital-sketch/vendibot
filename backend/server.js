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
const DATABASE_URL = process.env.DATABASE_URL || "";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

if (!process.env.SESSION_SECRET) {
  console.warn("Aviso: defina SESSION_SECRET em producao.");
}

if (!process.env.OPENAI_API_KEY) {
  console.warn("Aviso: defina OPENAI_API_KEY para gerar anuncios.");
}

if (!PASSWORD_RESET_CODE) {
  console.warn("Aviso: defina PASSWORD_RESET_CODE para recuperar senhas.");
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
      stripe_customer_id text,
      stripe_subscription_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      password_changed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS users_stripe_customer_id_idx
      ON users (stripe_customer_id);

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
        return line.slice(prefix.length).trim();
      }
    }
  }

  return "";
}

function safeListing(listing) {
  return {
    id: listing.id,
    title: listing.title || "Listing",
    suggestedPrice: listing.suggestedPrice || "",
    marketplace: listing.marketplace || "",
    language: listing.language || "",
    result: listing.result || "",
    createdAt: listing.createdAt,
  };
}

async function createListingRecord(user, listing) {
  const record = {
    id: crypto.randomUUID(),
    userId: user.id,
    title:
      listing.title ||
      parseListingField(listing.result, [
        "Title",
        "Titulo",
        "Titel",
        "Titulo",
      ]),
    suggestedPrice:
      listing.suggestedPrice ||
      parseListingField(listing.result, [
        "Suggested price",
        "Preco sugerido",
        "Adviesprijs",
        "Precio sugerido",
      ]),
    description: listing.description || "",
    highlights: listing.highlights || [],
    hashtags: listing.hashtags || [],
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
Preco sugerido:
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
Suggested price:
Description:
Highlights:
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
Adviesprijs:
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
Precio sugerido:
Descripcion:
Destacados:
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

      if (usage.generations >= monthlyLimit) {
        res.status(402).json({
          error:
            "Limite mensal atingido. Faca upgrade ou compre creditos para continuar.",
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
- Do not invent details that are not visible or provided.
- Use natural, modern, direct wording.
- Highlight real benefits and the apparent condition of the product.
- Mandatory output language: ${languageSettings.name}.
- Translate every section label and every sentence into ${languageSettings.name}, even if the seller description or marketplace name is in another language.
- ${languageSettings.currency}

Mandatory format:

${languageSettings.format}
`,
      });

      const response = await openai.responses.create({
        model: OPENAI_MODEL,
        input: [
          {
            role: "user",
            content,
          },
        ],
      });

      usage.generations += 1;
      await updateUser(req.user);
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
