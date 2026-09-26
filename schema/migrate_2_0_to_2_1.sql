-- =====================================================================
-- ConnectX Control — upgrade script: 2.0.x (workspaces) -> 2.1 (systems+shops)
-- =====================================================================
-- Run this ONCE against a database that was created with the 2.0 schema,
-- THEN re-apply schema/connectx_schema.sql:
--
--   local :  npm run db:migrate:local  &&  npm run db:local
--   remote:  npm run db:migrate:remote &&  npm run db:remote
--
-- The 2.0 "workspace" model was removed. Its tables (and the message /
-- device / key rows that point at workspaces) cannot be mapped to the
-- systems+shops model, so they are dropped here:
--
--   DROPPED : cx_workspaces, cx_clients, cx_jobs, cx_devices,
--             cx_pairing_codes, cx_api_keys
--   KEPT    : cx_operators  (owner/operator accounts + passwords),
--             cx_releases   (published APKs),
--             cx_sim_carriers (balance USSD catalog),
--             cx_settings   (email provider config incl. stored key),
--             cx_activity_log (audit trail; old rows stay readable)
--
-- On a FRESH database (never used 2.0) this file is a harmless no-op:
-- every statement is DROP TABLE IF EXISTS.
-- =====================================================================

DROP TABLE IF EXISTS cx_workspaces;
DROP TABLE IF EXISTS cx_clients;
DROP TABLE IF EXISTS cx_jobs;
DROP TABLE IF EXISTS cx_devices;
DROP TABLE IF EXISTS cx_pairing_codes;
DROP TABLE IF EXISTS cx_api_keys;
