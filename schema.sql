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
  updated_at timestamptz DEFAULT now()
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
  estimated_end timestamptz,
  is_resolved boolean DEFAULT false,
  updated_at timestamptz DEFAULT now()
);
