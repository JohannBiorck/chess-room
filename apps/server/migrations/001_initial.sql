CREATE TABLE player_sessions (
  id uuid PRIMARY KEY,
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  display_name varchar(40) NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX player_sessions_expiry ON player_sessions (expires_at);

CREATE TABLE matches (
  id uuid PRIMARY KEY,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  status text NOT NULL CHECK (status IN ('waiting', 'active', 'finished')),
  ruleset_id varchar(80) NOT NULL,
  rules_version integer NOT NULL CHECK (rules_version > 0),
  rules_config jsonb NOT NULL CHECK (jsonb_typeof(rules_config) = 'object'),
  engine_state jsonb NOT NULL CHECK (jsonb_typeof(engine_state) = 'object'),
  lifecycle jsonb NOT NULL CHECK (jsonb_typeof(lifecycle) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX matches_status_updated ON matches (status, updated_at);
CREATE INDEX matches_deadline ON matches (((lifecycle ->> 'deadlineAt')::bigint))
  WHERE status = 'active';

CREATE TABLE match_seats (
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  color text NOT NULL CHECK (color IN ('white', 'black')),
  session_id uuid NOT NULL REFERENCES player_sessions (id),
  PRIMARY KEY (match_id, color),
  UNIQUE (match_id, session_id)
);
CREATE INDEX match_seats_session ON match_seats (session_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  color text NOT NULL CHECK (color IN ('white', 'black')),
  token_hash char(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_by uuid REFERENCES player_sessions (id),
  consumed_at timestamptz,
  CHECK ((consumed_by IS NULL) = (consumed_at IS NULL))
);
CREATE UNIQUE INDEX invitations_available_seat ON invitations (match_id, color)
  WHERE consumed_at IS NULL;
CREATE INDEX invitations_expiry ON invitations (expires_at);

CREATE TABLE match_events (
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK (revision >= 0),
  type varchar(80) NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, revision)
);

CREATE TABLE command_receipts (
  match_id uuid NOT NULL REFERENCES matches (id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES player_sessions (id),
  command_id uuid NOT NULL,
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  acknowledgement jsonb NOT NULL CHECK (jsonb_typeof(acknowledgement) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (match_id, session_id, command_id)
);
CREATE INDEX command_receipts_created ON command_receipts (created_at);

CREATE TABLE event_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_id uuid NOT NULL,
  revision integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  FOREIGN KEY (match_id, revision) REFERENCES match_events (match_id, revision) ON DELETE CASCADE,
  UNIQUE (match_id, revision)
);
CREATE INDEX event_outbox_pending ON event_outbox (id) WHERE delivered_at IS NULL;

CREATE TABLE app_rate_limits (
  key text PRIMARY KEY,
  window_start bigint NOT NULL CHECK (window_start >= 0),
  count integer NOT NULL CHECK (count >= 0)
);
CREATE INDEX app_rate_limits_window ON app_rate_limits (window_start);
