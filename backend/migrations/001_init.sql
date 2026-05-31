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
