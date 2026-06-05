ALTER TABLE users
  ADD COLUMN IF NOT EXISTS credits_balance integer NOT NULL DEFAULT 0;

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
