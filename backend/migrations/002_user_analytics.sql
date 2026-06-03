ALTER TABLE users
  ADD COLUMN IF NOT EXISTS credits_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS copy_button_clicks integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS vinted_redirect_clicks integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paywall_views integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkout_attempts integer NOT NULL DEFAULT 0;
