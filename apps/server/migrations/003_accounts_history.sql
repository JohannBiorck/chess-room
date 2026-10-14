-- Stable identities keep the exact IDs used by every existing seat and receipt.
CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  primary_player_id uuid NOT NULL UNIQUE REFERENCES player_sessions(id),
  display_name varchar(40) NOT NULL,
  user_handle varchar(64) NOT NULL UNIQUE,
  recovery_locator varchar(64) NOT NULL UNIQUE,
  preferences jsonb NOT NULL DEFAULT '{"volume":45,"motion":"system"}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE players (
  id uuid PRIMARY KEY REFERENCES player_sessions(id) ON DELETE CASCADE,
  account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'human' CHECK (kind IN ('human','bot'))
);
INSERT INTO players(id) SELECT id FROM player_sessions;
CREATE INDEX players_account ON players(account_id) WHERE account_id IS NOT NULL;
CREATE TABLE account_sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claim_guest_id uuid,
  claim_guest_hash char(64),
  recovery_only boolean NOT NULL DEFAULT false
);
CREATE INDEX account_sessions_account ON account_sessions(account_id);
CREATE INDEX account_sessions_expiry ON account_sessions(expires_at);
CREATE TABLE account_credentials (
  id text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key bytea NOT NULL,
  counter bigint NOT NULL CHECK(counter>=0),
  transports jsonb NOT NULL,
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  label varchar(60) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_used_at timestamptz
);
CREATE INDEX account_credentials_account ON account_credentials(account_id);
CREATE TABLE authentication_challenges (
  id uuid PRIMARY KEY,
  challenge text NOT NULL,
  purpose text NOT NULL CHECK(purpose IN ('register','login','reauth','add-passkey','recover')),
  binding_hash char(64) NOT NULL,
  account_id uuid REFERENCES accounts(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX authentication_challenges_binding ON authentication_challenges(binding_hash);
CREATE INDEX authentication_challenges_expiry ON authentication_challenges(expires_at);
CREATE TABLE account_recovery_codes (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash char(64) NOT NULL,
  PRIMARY KEY(account_id,code_hash)
);
CREATE TABLE match_archives (
  match_id uuid PRIMARY KEY,
  schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
  ruleset_id text NOT NULL,
  rules_version integer NOT NULL,
  engine_state jsonb NOT NULL,
  lifecycle jsonb NOT NULL,
  players jsonb NOT NULL,
  final_fen varchar(128) NOT NULL,
  opponent_kind text NOT NULL DEFAULT 'human' CHECK(opponent_kind IN ('human','bot')),
  bot jsonb,
  created_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL
);
CREATE INDEX match_archives_finished ON match_archives(finished_at);
CREATE TABLE account_match_history (
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  match_id uuid NOT NULL REFERENCES match_archives(match_id) ON DELETE CASCADE,
  color text NOT NULL CHECK(color IN ('white','black')),
  finished_at timestamptz NOT NULL,
  hidden boolean NOT NULL DEFAULT false,
  PRIMARY KEY(account_id,match_id)
);
CREATE INDEX account_match_history_cursor ON account_match_history(account_id,finished_at DESC,match_id DESC) WHERE NOT hidden;
CREATE TABLE storage_reservations (
  match_id uuid PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  reserved_bytes bigint NOT NULL CHECK(reserved_bytes>0)
);
ALTER TABLE command_receipts ADD COLUMN compressed_acknowledgement bytea;
