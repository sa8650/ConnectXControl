-- =====================================================================
-- ConnectX Control — independent platform schema (Cloudflare D1 / SQLite)
-- =====================================================================
-- ConnectX is a standalone communication-gateway platform. It has its own
-- accounts, workspaces, devices, message jobs, client apps and releases.
-- Nothing here references EMS tables. External products (EMS, CareOS,
-- InfluenceOS, PlugX, ...) integrate through cx_clients + cx_api_keys.
-- =====================================================================

-- Control-panel accounts (owner + operators). The Android gateway signs in
-- with an operator account; it never uses another product's credentials.
CREATE TABLE IF NOT EXISTS cx_operators (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  phone         TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  operator_code TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('owner','operator')),
  active        INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Workspaces are the tenants a gateway device is paired to
-- (the device API still reports them under the legacy "shops" key).
CREATE TABLE IF NOT EXISTS cx_workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  code       TEXT NOT NULL UNIQUE,
  address    TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Paired Android gateway devices.
CREATE TABLE IF NOT EXISTS cx_devices (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL,
  operator_id         TEXT,
  device_public_id    TEXT NOT NULL UNIQUE,
  device_name         TEXT,
  android_version     TEXT,
  app_version         TEXT,
  sim_subscription_id TEXT,
  sim_carrier         TEXT,
  phone_number        TEXT,
  status              TEXT NOT NULL DEFAULT 'pending_test' CHECK (status IN ('pending_test','active','revoked')),
  is_primary          INTEGER NOT NULL DEFAULT 0,
  token_hash          TEXT,
  last_seen           TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cx_devices_ws     ON cx_devices(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_cx_devices_seen   ON cx_devices(last_seen DESC);

-- Short-lived pairing codes (alternative to operator sign-in on the phone).
CREATE TABLE IF NOT EXISTS cx_pairing_codes (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  created_by   TEXT,
  device_id    TEXT,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL
);

-- Integrated client products (EMS, CareOS, InfluenceOS, PlugX, custom...).
CREATE TABLE IF NOT EXISTS cx_clients (
  id          TEXT PRIMARY KEY,
  client_key  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  webhook_url TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- API keys handed to client products. Only the SHA-256 hash is stored;
-- the plain key is shown once at creation time.
CREATE TABLE IF NOT EXISTS cx_api_keys (
  id           TEXT PRIMARY KEY,
  client_id    TEXT NOT NULL,
  workspace_id TEXT,                       -- NULL = every workspace
  label        TEXT NOT NULL DEFAULT '',
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  daily_limit  INTEGER NOT NULL DEFAULT 1000,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_cx_keys_client ON cx_api_keys(client_id, status);

-- Unified outbound message jobs (SMS today; email history; future channels).
CREATE TABLE IF NOT EXISTS cx_jobs (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  client_id         TEXT,
  api_key_id        TEXT,
  channel           TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','email')),
  -- SMS
  to_phone          TEXT,
  -- Email (read-only history pushed by clients)
  from_email        TEXT,
  to_emails         TEXT,                   -- JSON array
  cc_emails         TEXT,                   -- JSON array
  bcc_emails        TEXT,                   -- JSON array
  subject           TEXT,
  body_html         TEXT,
  custom_body       TEXT,
  -- Common
  recipient_type    TEXT NOT NULL DEFAULT 'customer',
  recipient_id      TEXT,
  recipient_name    TEXT,
  message_type      TEXT,
  event_type        TEXT,
  reference_id      TEXT,                   -- client-side id (invoice, order...)
  reference_number  TEXT,                   -- client-side human number
  message_body      TEXT,
  status            TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','sending','sent','failed','cancelled')),
  device_id         TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 3,
  idempotency_key   TEXT,
  claimed_at        TEXT,
  error_message     TEXT,
  provider_message_id TEXT,
  created_at        TEXT NOT NULL,
  sent_at           TEXT
);
-- NULL idempotency keys never collide (SQLite treats NULLs as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cx_jobs_idem    ON cx_jobs(workspace_id, client_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_cx_jobs_claim          ON cx_jobs(workspace_id, channel, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cx_jobs_ws_created     ON cx_jobs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cx_jobs_client_created ON cx_jobs(client_id, created_at DESC);

-- ConnectX update channel (replaces the old EMS App Store dependency).
CREATE TABLE IF NOT EXISTS cx_releases (
  id             TEXT PRIMARY KEY,
  package_name   TEXT NOT NULL,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  version        TEXT NOT NULL DEFAULT '1.0.0',
  version_code   INTEGER NOT NULL DEFAULT 1,
  mandatory      INTEGER NOT NULL DEFAULT 0,
  release_notes  TEXT NOT NULL DEFAULT '',
  apk_filename   TEXT NOT NULL DEFAULT '',
  apk_size_bytes INTEGER NOT NULL DEFAULT 0,
  apk_r2_key     TEXT,
  apk_url        TEXT NOT NULL DEFAULT '',
  published      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cx_releases_pkg ON cx_releases(package_name, published, version_code DESC);

-- Owner-managed carrier catalog for SIM balance USSD lookups.
CREATE TABLE IF NOT EXISTS cx_sim_carriers (
  id                 TEXT PRIMARY KEY,
  carrier_name       TEXT NOT NULL,
  carrier_identifier TEXT,
  mcc_mnc            TEXT,
  balance_ussd_code  TEXT,
  balance_pattern    TEXT,
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- Key/value platform settings (JSON values).
CREATE TABLE IF NOT EXISTS cx_settings (
  setting_key   TEXT PRIMARY KEY,
  setting_value TEXT,
  updated_at    TEXT NOT NULL
);

-- Audit trail for the control website.
CREATE TABLE IF NOT EXISTS cx_activity_log (
  id          TEXT PRIMARY KEY,
  actor_type  TEXT NOT NULL,               -- operator | device | client | system
  actor_id    TEXT,
  actor_label TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  meta        TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cx_activity_created ON cx_activity_log(created_at DESC);
