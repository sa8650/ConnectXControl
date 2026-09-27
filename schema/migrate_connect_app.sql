-- Connect App tables. Products and the Android app connect here.
-- The old client API keys and device tokens are no longer used.
-- Safe to run more than once (CREATE IF NOT EXISTS). ALTER statements
-- are not included; this file is the full new schema.

CREATE TABLE IF NOT EXISTS cx_connect_identity (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  application_id    TEXT NOT NULL UNIQUE,
  application_name  TEXT NOT NULL DEFAULT 'ConnectX',
  kind              TEXT NOT NULL DEFAULT 'gateway',
  endpoint_override TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cx_connect_requests (
  id                      TEXT PRIMARY KEY,
  direction               TEXT NOT NULL,
  pairing_code            TEXT,
  remote_application_id   TEXT,
  remote_application_name TEXT,
  remote_endpoint         TEXT NOT NULL DEFAULT '',
  remote_kind             TEXT NOT NULL DEFAULT 'product',
  display_name            TEXT,
  requested_permissions   TEXT,
  status                  TEXT NOT NULL,
  connection_id           TEXT,
  handshake_json          TEXT,
  created_at              TEXT NOT NULL,
  expires_at              TEXT
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

CREATE TABLE IF NOT EXISTS cx_connect_jobs (
  id                   TEXT PRIMARY KEY,
  connection_id        TEXT NOT NULL,
  request_id           TEXT NOT NULL,
  recipient            TEXT NOT NULL,
  message              TEXT NOT NULL,
  status               TEXT NOT NULL,
  device_connection_id TEXT,
  sim_used             TEXT,
  reason               TEXT,
  meta                 TEXT,
  result_at            TEXT,
  callback_status      TEXT,
  callback_error       TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  UNIQUE (connection_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_cx_connect_jobs_status ON cx_connect_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_cx_connect_jobs_device ON cx_connect_jobs(device_connection_id, status);

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
CREATE INDEX IF NOT EXISTS idx_cx_phone_shop ON cx_phone_devices(connection_id, shop_id, status);
