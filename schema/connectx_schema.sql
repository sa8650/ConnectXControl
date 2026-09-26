-- =====================================================================
-- ConnectX Control  - independent platform schema (Cloudflare D1 / SQLite)
-- =====================================================================
-- ConnectX is a standalone communication-gateway platform:
--
--   * SYSTEMS  (cx_systems)   - the allied products whose administrators
--     use the Android gateway (EMS today  - InfluenceOS, CareOS, PlugX...).
--     Each system's API URL + auth paths are configured centrally here  -
--     the Android app never stores or calls them directly.
--   * ADMINS   (cx_admins)    - administrators verified THROUGH a system
--     (federated login: app -> ConnectX -> system API). No passwords are
--     stored  - only a short-lived system session token for shop re-sync.
--   * SHOPS    (cx_shops)     - the shops an administrator may connect a
--     gateway to, synced from the system (or provisioned manually).
--   * DEVICES  (cx_devices)   - paired Android gateway phones (per shop).
--   * JOBS     (cx_jobs)      - unified outbound messages (SMS + email).
--
-- Nothing here references another product's database. External products
-- push work through cx_systems + cx_api_keys and receive webhook results.
-- =====================================================================

-- Control-panel accounts (owner + operators) for the website itself.
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

-- Integrated systems (EMS, InfluenceOS, CareOS, PlugX, custom...).
-- The Android app shows active systems on its sign-in screen  - ConnectX
-- calls api_url/login_path to verify administrators and api_url/shops_path
-- to list their shops.
-- auth_mode selects the integration contract:
--   'federated' (legacy) - login_path returns a system session token that
--                          authorizes the shops_path call.
--   'api_key'   (EMS Public API v1) - api_key holds the owner-issued
--                          platform key (emsk_...); login_path is called
--                          WITH that key and answers administrator+shops+
--                          entitlement in one shot; ConnectX additionally
--                          PULLS queued SMS from the system (see pull.js)
--                          and reports results back.
CREATE TABLE IF NOT EXISTS cx_systems (
  id          TEXT PRIMARY KEY,
  system_key  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  api_url     TEXT NOT NULL DEFAULT '',
  auth_mode   TEXT NOT NULL DEFAULT 'federated' CHECK (auth_mode IN ('federated','api_key')),
  api_key     TEXT NOT NULL DEFAULT '',      -- system-side platform key (never returned by the API)
  login_path  TEXT NOT NULL DEFAULT 'api/auth/admin/login',
  shops_path  TEXT NOT NULL DEFAULT 'api/connectx/gateway/shops',
  webhook_url TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_pull_at    TEXT,                      -- dispatch-loop state (api_key systems)
  last_pull_error TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Administrators of external systems, verified through federated login.
-- system_token is the LIVE session token issued by that system (used to
-- re-sync shops)  - it expires and is then replaced by a fresh sign-in.
CREATE TABLE IF NOT EXISTS cx_admins (
  id               TEXT PRIMARY KEY,
  system_id        TEXT NOT NULL,
  external_id      TEXT,
  email            TEXT NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  admin_code       TEXT,
  system_token     TEXT,
  system_token_exp TEXT,
  last_login_at    TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (system_id, email)
);
CREATE INDEX IF NOT EXISTS idx_cx_admins_system ON cx_admins(system_id);

-- Shops synced from a system (or provisioned manually by the owner).
-- external_id is the shop's id inside that system (opaque to ConnectX).
CREATE TABLE IF NOT EXISTS cx_shops (
  id            TEXT PRIMARY KEY,
  system_id     TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  shop_code     TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  system_status TEXT NOT NULL DEFAULT 'active',  -- last value reported by the system
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (system_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_cx_shops_system ON cx_shops(system_id, status);

-- Paired Android gateway devices (one shop per device registration).
CREATE TABLE IF NOT EXISTS cx_devices (
  id                  TEXT PRIMARY KEY,
  shop_id             TEXT NOT NULL,
  admin_id            TEXT,
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
CREATE INDEX IF NOT EXISTS idx_cx_devices_shop ON cx_devices(shop_id, status);
CREATE INDEX IF NOT EXISTS idx_cx_devices_seen ON cx_devices(last_seen DESC);

-- Short-lived pairing codes (alternative to administrator sign-in on the
-- phone). A code is bound to one shop of one system.
CREATE TABLE IF NOT EXISTS cx_pairing_codes (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  shop_id    TEXT NOT NULL,
  created_by TEXT,
  device_id  TEXT,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL
);

-- API keys handed to systems for the client API. Only the SHA-256 hash is
-- stored  - the plain key is shown once at creation time.
CREATE TABLE IF NOT EXISTS cx_api_keys (
  id           TEXT PRIMARY KEY,
  system_id    TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  daily_limit  INTEGER NOT NULL DEFAULT 1000,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_cx_keys_system ON cx_api_keys(system_id, status);

-- Unified outbound message jobs (SMS + email).
CREATE TABLE IF NOT EXISTS cx_jobs (
  id                TEXT PRIMARY KEY,
  shop_id           TEXT NOT NULL,
  system_id         TEXT,
  api_key_id        TEXT,
  channel           TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','email')),
  -- SMS
  to_phone          TEXT,
  -- Email
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
  reference_id      TEXT,                   -- caller-side id (invoice, order...)
  reference_number  TEXT,                   -- caller-side human number
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
  -- Jobs PULLED from an api_key system (EMS v1 sms/claim) carry the
  -- system-side job id here; delivery results are reported back to it.
  external_job_id     TEXT,
  created_at        TEXT NOT NULL,
  sent_at           TEXT
);
-- NULL idempotency keys never collide (SQLite treats NULLs as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS idx_cx_jobs_idem    ON cx_jobs(shop_id, system_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_cx_jobs_claim          ON cx_jobs(shop_id, channel, status, created_at);
CREATE INDEX IF NOT EXISTS idx_cx_jobs_shop_created   ON cx_jobs(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cx_jobs_system_created ON cx_jobs(system_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cx_jobs_external ON cx_jobs(system_id, external_job_id)
  WHERE external_job_id IS NOT NULL;

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
--   'sms'   -> global gateway toggle + message templates ({enabled, templates})
--   'email' -> provider config for the email gateway (owner-only  - the API
--             key stored here is never returned by any GET endpoint)
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
