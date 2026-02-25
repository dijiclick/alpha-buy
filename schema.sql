-- Events table
CREATE TABLE IF NOT EXISTS events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  polymarket_event_id text UNIQUE NOT NULL,
  title text,
  description text,
  slug text,
  tags jsonb DEFAULT '[]',
  image text,
  start_date timestamptz,
  end_date timestamptz,
  neg_risk boolean DEFAULT false,
  neg_risk_market_id text,
  active boolean DEFAULT true,
  closed boolean DEFAULT false,
  markets_count int DEFAULT 0,
  total_volume numeric DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  last_checked_at timestamptz
);

-- Markets table
CREATE TABLE IF NOT EXISTS markets (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id bigint REFERENCES events(id),
  polymarket_market_id text UNIQUE NOT NULL,
  condition_id text,
  question_id text,
  question text,
  question_normalized text,
  description text,
  slug text,
  outcomes jsonb DEFAULT '["Yes","No"]',
  outcome_prices jsonb,
  clob_token_ids jsonb,
  best_ask numeric,
  last_trade_price numeric,
  spread numeric,
  volume numeric DEFAULT 0,
  volume_clob numeric DEFAULT 0,
  volume_1d numeric DEFAULT 0,
  volume_1wk numeric DEFAULT 0,
  volume_1mo numeric DEFAULT 0,
  one_day_price_change numeric,
  end_date timestamptz,
  active boolean DEFAULT true,
  closed boolean DEFAULT false,
  accepting_orders boolean DEFAULT true,
  neg_risk boolean DEFAULT false,
  updated_at timestamptz DEFAULT now()
);

-- Outcomes table
CREATE TABLE IF NOT EXISTS outcomes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  market_id bigint UNIQUE REFERENCES markets(id),
  detected_outcome text,
  confidence int DEFAULT 0,
  detection_source text,
  detected_at timestamptz,
  estimated_end_min timestamptz,
  estimated_end_max timestamptz,
  is_resolved boolean DEFAULT false,
  profit_pct numeric,
  updated_at timestamptz DEFAULT now()
);

-- Edge predictions table (AI outcome predictions for near-term events)
CREATE TABLE IF NOT EXISTS edge_predictions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id text NOT NULL,
  event_title text NOT NULL,
  event_slug text,
  event_end_date timestamptz,
  market_id text NOT NULL,
  market_question text NOT NULL,
  predicted_outcome text NOT NULL,
  probability int NOT NULL DEFAULT 0,
  reasoning text,
  ai_summary text,
  yes_price numeric(6,4),
  no_price numeric(6,4),
  best_ask numeric(6,4),
  best_bid numeric(6,4),
  divergence numeric(6,4),
  profit_pct numeric(8,4),
  alert_sent boolean DEFAULT false,
  alert_sent_at timestamptz,
  actual_outcome text,
  was_correct boolean,
  resolved_at timestamptz,
  final_yes_price numeric(6,4),
  final_no_price numeric(6,4),
  resolution_source text,
  detected_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(event_id, market_id)
);
