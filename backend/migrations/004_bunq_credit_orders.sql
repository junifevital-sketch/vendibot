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
