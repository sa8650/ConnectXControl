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

CREATE TABLE IF NOT EXISTS cx_systems (
  id          TEXT PRIMARY KEY,
  system_key  TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  api_url     TEXT NOT NULL DEFAULT '',
  auth_mode   TEXT NOT NULL DEFAULT 'federated' CHECK (auth_mode IN ('federated','api_key')),
  api_key     TEXT NOT NULL DEFAULT '',
  login_path  TEXT NOT NULL DEFAULT 'api/auth/admin/login',
  shops_path  TEXT NOT NULL DEFAULT 'api/connectx/gateway/shops',
  webhook_url TEXT,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  last_pull_at    TEXT,
  last_pull_error TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cx_shops (
  id            TEXT PRIMARY KEY,
  system_id     TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  name          TEXT NOT NULL,
  shop_code     TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT '',
  system_status TEXT NOT NULL DEFAULT 'active',
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (system_id, external_id)
);

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

CREATE TABLE IF NOT EXISTS cx_jobs (
  id                TEXT PRIMARY KEY,
  shop_id           TEXT NOT NULL,
  system_id         TEXT,
  api_key_id        TEXT,
  channel           TEXT NOT NULL DEFAULT 'sms' CHECK (channel IN ('sms','email')),
  to_phone          TEXT,
  from_email        TEXT,
  to_emails         TEXT,
  cc_emails         TEXT,
  bcc_emails        TEXT,
  subject           TEXT,
  body_html         TEXT,
  custom_body       TEXT,
  recipient_type    TEXT NOT NULL DEFAULT 'customer',
  recipient_id      TEXT,
  recipient_name    TEXT,
  message_type      TEXT,
  event_type        TEXT,
  reference_id      TEXT,
  reference_number  TEXT,
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

CREATE TABLE IF NOT EXISTS cx_settings (
  setting_key   TEXT PRIMARY KEY,
  setting_value TEXT,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cx_activity_log (
  id          TEXT PRIMARY KEY,
  actor_type  TEXT NOT NULL,
  actor_id    TEXT,
  actor_label TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  meta        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cx_connect_identity (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  application_id    TEXT NOT NULL UNIQUE,
  application_name  TEXT NOT NULL DEFAULT 'ConnectX',
  kind              TEXT NOT NULL DEFAULT 'gateway',
  endpoint_override TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cx_connect_connections (
  id                      TEXT PRIMARY KEY,
  remote_application_id   TEXT NOT NULL,
  remote_application_name TEXT NOT NULL,
  remote_endpoint         TEXT NOT NULL DEFAULT '',
  remote_kind             TEXT NOT NULL DEFAULT 'product',
  permissions             TEXT NOT NULL DEFAULT '[]',
  shared_secret           TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'ACTIVE',
  display_name            TEXT,
  device_name             TEXT,
  sim_label               TEXT,
  app_version             TEXT,
  connected_at            TEXT,
  disconnected_at         TEXT,
  last_seen_at            TEXT,
  created_at              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cx_phone_devices (
  id                   TEXT PRIMARY KEY,
  connection_id        TEXT NOT NULL,
  admin_id             TEXT NOT NULL,
  admin_email          TEXT,
  admin_name           TEXT,
  admin_code           TEXT,
  shop_id              TEXT NOT NULL,
  shop_name            TEXT,
  shop_address         TEXT,
  shop_phone           TEXT,
  shop_code            TEXT,
  device_name          TEXT,
  sim_subscription_id  INTEGER,
  sim_carrier          TEXT,
  phone_number         TEXT,
  app_version          TEXT,
  version_code         INTEGER,
  android_version      TEXT,
  status               TEXT NOT NULL DEFAULT 'active',
  last_seen_at         TEXT,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cx_monitor_devices (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  admin_id TEXT NOT NULL,
  admin_code TEXT NOT NULL DEFAULT '',
  admin_name TEXT NOT NULL DEFAULT '',
  admin_email TEXT NOT NULL DEFAULT '',
  shop_id TEXT NOT NULL DEFAULT '',
  shop_name TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL DEFAULT 'Android phone',
  android_version TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  version_code INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  last_seen TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cx_monitor_device_details (
  device_id TEXT PRIMARY KEY,
  sim_subscription_id TEXT NOT NULL DEFAULT '',
  sim_carrier TEXT NOT NULL DEFAULT '',
  phone_number TEXT NOT NULL DEFAULT '',
  device_status TEXT NOT NULL DEFAULT 'active' CHECK (device_status IN ('active','pending_test')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cx_monitor_sms (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  admin_code TEXT NOT NULL DEFAULT '',
  admin_name TEXT NOT NULL DEFAULT '',
  shop_id TEXT NOT NULL DEFAULT '',
  shop_name TEXT NOT NULL DEFAULT '',
  recipient_phone TEXT NOT NULL DEFAULT '',
  recipient_name TEXT NOT NULL DEFAULT '',
  message_type TEXT NOT NULL DEFAULT 'SMS',
  status TEXT NOT NULL CHECK (status IN ('processing','sent','delivered','failed','unknown','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  delivered_at TEXT,
  result_at TEXT,
  app_version TEXT NOT NULL DEFAULT '',
  version_code INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cx_shops_system ON cx_shops(system_id, status);

CREATE INDEX IF NOT EXISTS idx_cx_keys_system ON cx_api_keys(system_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cx_jobs_idem    ON cx_jobs(shop_id, system_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_cx_jobs_claim          ON cx_jobs(shop_id, channel, status, created_at);

CREATE INDEX IF NOT EXISTS idx_cx_jobs_shop_created   ON cx_jobs(shop_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cx_jobs_system_created ON cx_jobs(system_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cx_releases_pkg ON cx_releases(package_name, published, version_code DESC);

CREATE INDEX IF NOT EXISTS idx_cx_activity_created ON cx_activity_log(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cx_phone_shop ON cx_phone_devices(connection_id, shop_id, status);
CREATE INDEX IF NOT EXISTS idx_cx_monitor_devices_seen ON cx_monitor_devices(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_cx_monitor_devices_admin ON cx_monitor_devices(admin_id, status);
CREATE INDEX IF NOT EXISTS idx_cx_monitor_sms_created ON cx_monitor_sms(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cx_monitor_sms_shop_created ON cx_monitor_sms(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cx_monitor_sms_status_created ON cx_monitor_sms(status, created_at DESC);

DROP TABLE IF EXISTS cx_workspaces;
DROP TABLE IF EXISTS cx_clients;
DROP TABLE IF EXISTS cx_admins;
DROP TABLE IF EXISTS cx_devices;
DROP TABLE IF EXISTS cx_pairing_codes;
DROP TABLE IF EXISTS cx_sim_carriers;
DROP TABLE IF EXISTS cx_monitor_enrollments;
DROP TABLE IF EXISTS cx_connect_requests;
DROP TABLE IF EXISTS cx_connect_jobs;
